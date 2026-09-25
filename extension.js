/* extension.js
 *
 * Disk & RAM Monitor — GNOME Shell 45/46/47/48 (ESM)
 *
 * Añade un indicador en el panel superior que, al hacer clic, despliega un
 * menú con una barra horizontal por cada unidad de disco montada en el
 * sistema, más una barra para la memoria RAM. En cada barra:
 *   - El ancho total representa la CAPACIDAD de la unidad.
 *   - En un color distinto se muestra la cantidad OCUPADA.
 * El nombre de cada fila corresponde al nombre real de la unidad en el
 * sistema (p. ej. sda1, nvme0n1p2) junto con su punto de montaje.
 */

import GObject from 'gi://GObject';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const REFRESH_SECONDS = 3;      // cada cuánto se actualizan los datos
const BAR_WIDTH = 240;          // ancho de la barra en píxeles

// ---- Utilidades -----------------------------------------------------------

// Convierte bytes a una unidad legible (base 1024) con 1 decimal.
function fmtSize(bytes) {
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
    let v = bytes;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
    }
    if (Math.abs(v - Math.round(v)) < 0.05)
        return `${Math.round(v)} ${units[i]}`;
    return `${v.toFixed(1)} ${units[i]}`;
}

// Sistemas de archivos que NO corresponden a unidades reales de almacenamiento.
const PSEUDO_FS = new Set([
    'squashfs', 'tmpfs', 'devtmpfs', 'proc', 'sysfs', 'cgroup', 'cgroup2',
    'overlay', 'ramfs', 'autofs', 'mqueue', 'debugfs', 'tracefs', 'fusectl',
    'configfs', 'securityfs', 'pstore', 'bpf', 'devpts', 'hugetlbfs',
    'binfmt_misc', 'efivarfs',
]);

// Decodifica las secuencias octales (\040 = espacio, etc.) de /proc/mounts.
function unescapeMount(s) {
    return s.replace(/\\(\d{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
}

// Lee un archivo de texto y normaliza los espacios (para /sys/.../model).
function readTextTrim(path) {
    try {
        const [ok, contents] = GLib.file_get_contents(path);
        if (!ok)
            return '';
        return new TextDecoder().decode(contents).replace(/\s+/g, ' ').trim();
    } catch (e) {
        return '';
    }
}

// Construye un mapa "dispositivo -> etiqueta" leyendo los symlinks de un
// directorio como /dev/disk/by-label o /dev/disk/by-partlabel.
// Los enlaces apuntan a ../../<dispositivo>, así que usamos el basename.
function symlinkLabelMap(dir) {
    const map = new Map();
    try {
        const d = Gio.File.new_for_path(dir);
        const en = d.enumerate_children(
            'standard::name', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        let info;
        while ((info = en.next_file(null)) !== null) {
            const label = info.get_name();
            try {
                const target = GLib.file_read_link(`${dir}/${label}`);
                const dev = GLib.path_get_basename(target);   // p. ej. nvme0n1p1
                map.set(dev, label);
            } catch (e) {
                // enlace roto: se ignora
            }
        }
    } catch (e) {
        // el directorio puede no existir en algunos sistemas
    }
    return map;
}

// Devuelve el modelo físico del disco al que pertenece una partición
// (p. ej. "Samsung 512GB"), leyendo /sys.
function diskModel(short) {
    let parent = short;
    // ¿Es una partición? Entonces su disco padre es el penúltimo componente
    // de la ruta real en /sys.
    if (GLib.file_test(`/sys/class/block/${short}/partition`, GLib.FileTest.EXISTS)) {
        try {
            const target = GLib.file_read_link(`/sys/class/block/${short}`);
            const parts = target.split('/').filter(p => p && p !== '..');
            if (parts.length >= 2)
                parent = parts[parts.length - 2];
        } catch (e) {
            // se mantiene "short"
        }
    }
    return readTextTrim(`/sys/block/${parent}/device/model`);
}

// Enumera las unidades de disco reales a partir de /proc/mounts.
// Devuelve un array de {device, mount, name}.
function listDisks() {
    const disks = [];
    try {
        const [ok, contents] = GLib.file_get_contents('/proc/mounts');
        if (!ok)
            return disks;

        const text = new TextDecoder().decode(contents);
        const byDevice = new Map();   // dedupe por dispositivo (subvolúmenes btrfs, etc.)

        for (const line of text.split('\n')) {
            if (!line.trim())
                continue;
            const parts = line.split(/\s+/);
            const device = unescapeMount(parts[0]);
            const mount = unescapeMount(parts[1]);
            const fstype = parts[2];

            // Solo dispositivos de bloque reales; descartar loops y pseudo-fs.
            if (!device.startsWith('/dev/'))
                continue;
            if (device.startsWith('/dev/loop'))
                continue;
            if (PSEUDO_FS.has(fstype))
                continue;

            // Si el mismo dispositivo aparece varias veces, quedarse con el
            // punto de montaje más corto (el "principal").
            const prev = byDevice.get(device);
            if (!prev || mount.length < prev.mount.length)
                byDevice.set(device, {device, mount, fstype});
        }

        // Mapas de etiquetas (etiqueta de sistema de archivos y de partición).
        const fsLabels = symlinkLabelMap('/dev/disk/by-label');
        const partLabels = symlinkLabelMap('/dev/disk/by-partlabel');

        for (const {device, mount} of byDevice.values()) {
            // Nombre real de la unidad: p. ej. "sda1", "nvme0n1p2".
            const short = device.replace(/^\/dev\//, '');
            const label = fsLabels.get(short) || partLabels.get(short) || '';
            const model = diskModel(short);

            // Línea principal: la etiqueta si existe; si no, el dispositivo.
            const name = label || short;

            // Línea secundaria: dispositivo (si no se usó ya), modelo y montaje.
            const details = [];
            if (label)
                details.push(short);
            if (model)
                details.push(model);
            details.push(mount);
            const sub = details.join(' · ');

            disks.push({device, mount, short, label, model, name, sub});
        }

        // Ordenar por punto de montaje para una vista estable.
        disks.sort((a, b) => a.mount.localeCompare(b.mount));
    } catch (e) {
        logError(e, 'disk-ram-monitor: no se pudieron enumerar los discos');
    }
    return disks;
}

// Lee tamaño total/usado de un punto de montaje concreto.
function readDiskUsage(mount) {
    try {
        const file = Gio.File.new_for_path(mount);
        const info = file.query_filesystem_info(
            'filesystem::size,filesystem::used,filesystem::free', null);

        const total = info.get_attribute_uint64('filesystem::size');
        let used = 0;
        if (info.has_attribute('filesystem::used')) {
            used = info.get_attribute_uint64('filesystem::used');
        } else {
            const free = info.get_attribute_uint64('filesystem::free');
            used = total - free;
        }
        return {total, used};
    } catch (e) {
        return {total: 0, used: 0};
    }
}

// Lee memoria total/usada desde /proc/meminfo (valores en kB).
function readRam() {
    try {
        const [ok, contents] = GLib.file_get_contents('/proc/meminfo');
        if (!ok)
            return {total: 0, used: 0};

        const text = new TextDecoder().decode(contents);
        const map = {};
        for (const line of text.split('\n')) {
            const m = line.match(/^(\w+):\s+(\d+)\s*kB/);
            if (m)
                map[m[1]] = parseInt(m[2], 10) * 1024; // a bytes
        }
        const total = map['MemTotal'] || 0;
        // MemAvailable es la mejor estimación de lo realmente disponible.
        const available = (map['MemAvailable'] !== undefined)
            ? map['MemAvailable']
            : (map['MemFree'] || 0) + (map['Buffers'] || 0) + (map['Cached'] || 0);
        const used = Math.max(0, total - available);
        return {total, used};
    } catch (e) {
        logError(e, 'disk-ram-monitor: no se pudo leer la RAM');
        return {total: 0, used: 0};
    }
}

// ---- Widget de una fila (nombre + barra + total) --------------------------

const MeterRow = GObject.registerClass(
class MeterRow extends St.BoxLayout {
    _init(name, sub = '') {
        super._init({
            style_class: 'drm-row',
            vertical: false,
            x_expand: true,
        });

        // Bloque de nombre: línea principal (etiqueta) + línea de detalle
        // (dispositivo · modelo · montaje).
        this._nameBox = new St.BoxLayout({
            vertical: true,
            style_class: 'drm-namebox',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._name = new St.Label({
            text: name,
            style_class: 'drm-name',
        });
        this._sub = new St.Label({
            text: sub,
            style_class: 'drm-sub',
        });
        this._sub.clutter_text.line_wrap = true;
        this._nameBox.add_child(this._name);
        this._nameBox.add_child(this._sub);
        this.add_child(this._nameBox);

        // Contenedor de la barra: ancho fijo = 100% de la capacidad. Usa dos
        // capas superpuestas (BinLayout):
        //   - Capa de color: caja "usado" (color) + caja "libre" (fondo).
        //   - Capa de texto: los números flotan sobre TODA la barra.
        this._barBg = new St.Widget({
            style_class: 'drm-bar-bg',
            layout_manager: new Clutter.BinLayout(),
            y_align: Clutter.ActorAlign.CENTER,
            width: BAR_WIDTH,
            clip_to_allocation: true,
        });

        // --- Capa 1: proporción de color -----------------------------------
        const colorLayer = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            y_expand: true,
        });
        this._fillBox = new St.BoxLayout({
            style_class: 'drm-bar-fill',
            x_expand: false,
            y_expand: true,
        });
        this._restBox = new St.BoxLayout({
            style_class: 'drm-bar-rest',
            x_expand: true,
            y_expand: true,
        });
        colorLayer.add_child(this._fillBox);
        colorLayer.add_child(this._restBox);

        // --- Capa 2: textos (encima del color) -----------------------------
        const textLayer = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            y_expand: true,
        });
        this._usedLabel = new St.Label({
            text: '',
            style_class: 'drm-used-text',
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._freeLabel = new St.Label({
            text: '',
            style_class: 'drm-free-text',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });
        textLayer.add_child(this._usedLabel);
        textLayer.add_child(this._freeLabel);

        this._barBg.add_child(colorLayer);   // debajo
        this._barBg.add_child(textLayer);    // encima
        this.add_child(this._barBg);

        // Total (capacidad) como texto suelto a la derecha, fuera de la barra.
        this._totalBox = new St.Label({
            text: '',
            style_class: 'drm-total-text',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._totalBox);
    }

    setName(name, sub = '') {
        this._name.text = name;
        this._sub.text = sub;
        this._sub.visible = sub.length > 0;
    }

    update(used, total) {
        const fraction = total > 0 ? Math.min(1, used / total) : 0;
        const free = Math.max(0, total - used);

        // Ancho interior real de la barra (descontando el borde de 1px).
        const inner = BAR_WIDTH - 2;
        const fillWidth = Math.round(fraction * inner);
        this._fillBox.width = fillWidth;

        // Los números se muestran SIEMPRE, completos, sobre toda la barra.
        this._usedLabel.text = fmtSize(used);
        this._freeLabel.text = `${fmtSize(free)} libre`;
        this._totalBox.text = fmtSize(total);

        // Color de alerta cuando el uso es alto.
        this._fillBox.remove_style_class_name('drm-warn');
        this._fillBox.remove_style_class_name('drm-crit');
        if (fraction >= 0.9)
            this._fillBox.add_style_class_name('drm-crit');
        else if (fraction >= 0.75)
            this._fillBox.add_style_class_name('drm-warn');
    }
});

// Fila de sección (encabezado dentro del área de contenido).
const SectionLabel = GObject.registerClass(
class SectionLabel extends St.Label {
    _init(text) {
        super._init({text, style_class: 'drm-section'});
    }
});

// ---- Indicador del panel ---------------------------------------------------

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'Disk & RAM Monitor', false);

        // Ícono en el panel.
        this._icon = new St.Icon({
            icon_name: 'drive-harddisk-symbolic',
            style_class: 'system-status-icon',
        });
        this.add_child(this._icon);

        // Encabezado del menú.
        const title = new PopupMenu.PopupMenuItem('Uso del sistema', {
            reactive: false,
            can_focus: false,
        });
        title.label.add_style_class_name('drm-title');
        this.menu.addMenuItem(title);

        // Contenedor principal (no reactivo) con todas las filas.
        this._item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        this._box = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'drm-box',
        });
        this._item.add_child(this._box);
        this.menu.addMenuItem(this._item);

        // Estado interno.
        this._diskRows = new Map();     // device -> MeterRow
        this._ramRow = null;
        this._diskKey = '';             // firma del conjunto de discos actual

        // Refrescar al abrir el menú.
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._refresh();
        });
    }

    // (Re)construye las filas si cambió el conjunto de discos montados.
    _rebuild(disks) {
        this._box.destroy_all_children();
        this._diskRows.clear();

        this._box.add_child(new SectionLabel('Unidades de disco'));
        if (disks.length === 0) {
            this._box.add_child(new St.Label({
                text: 'No se detectaron unidades',
                style_class: 'drm-empty',
            }));
        }
        for (const disk of disks) {
            const row = new MeterRow(disk.name, disk.sub);
            this._box.add_child(row);
            this._diskRows.set(disk.device, row);
        }

        this._box.add_child(new SectionLabel('Memoria RAM'));
        this._ramRow = new MeterRow('RAM', 'Memoria física del sistema');
        this._box.add_child(this._ramRow);
    }

    _refresh() {
        const disks = listDisks();

        // Firma del conjunto (dispositivo + nombre + detalle) para detectar cambios.
        const key = disks.map(d => `${d.device}|${d.name}|${d.sub}`).join('\n');
        if (key !== this._diskKey) {
            this._diskKey = key;
            this._rebuild(disks);
        }

        for (const disk of disks) {
            const row = this._diskRows.get(disk.device);
            if (!row)
                continue;
            const {used, total} = readDiskUsage(disk.mount);
            row.update(used, total);
        }

        if (this._ramRow) {
            const ram = readRam();
            this._ramRow.update(ram.used, ram.total);
        }
    }
});

// ---- Extensión -------------------------------------------------------------

export default class DiskRamMonitorExtension extends Extension {
    enable() {
        this._indicator = new Indicator();
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._indicator._refresh();

        // Actualización periódica en segundo plano.
        this._timeout = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, REFRESH_SECONDS, () => {
                this._indicator._refresh();
                return GLib.SOURCE_CONTINUE;
            });
    }

    disable() {
        if (this._timeout) {
            GLib.Source.remove(this._timeout);
            this._timeout = null;
        }
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}
