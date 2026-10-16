# Disk & RAM Monitor — GNOME Shell Extension

Extensión para GNOME Shell (45 / 46 / 47 / 48 / 49 / 50) que agrega un ícono en el panel
superior. Al hacer clic despliega un menú con una barra horizontal tipo medidor
por cada **unidad de disco montada** del sistema, más una para la **memoria RAM**,
mostrando en tiempo real:

- **Unidades de disco**: una barra por cada partición real montada, con su
  **etiqueta** (o el nombre del dispositivo si no tiene) como título y, debajo,
  el **dispositivo · modelo físico · punto de montaje**
  (p. ej. `disco2` → `nvme0n1p1 · Samsung 512GB · /media/usuario/disco2`).
- **Memoria RAM**: usado / libre / total.

La barra completa representa el 100% de la capacidad; la parte de color es lo
utilizado y la parte blanca lo libre. El color pasa a **amarillo** al superar el
75% y a **rojo** sobre el 90%. Los valores se muestran siempre, sobre toda la
barra, y la información se actualiza cada pocos segundos. Las unidades se
detectan automáticamente al conectarlas o desconectarlas (USB, etc.).

Toda la información se obtiene sin privilegios de root: los tamaños vía GIO, las
etiquetas desde `/dev/disk/by-label` y `/dev/disk/by-partlabel`, y los modelos
desde `/sys/block/*/device/model`.

## Análisis de uso por categorías

La barra de cada unidad es un **gráfico segmentado por colores** que muestra en
qué se ocupa el espacio. El escaneo (con `du`, en segundo plano, sin congelar el
escritorio) se ejecuta **automáticamente al iniciar sesión y se repite cada 4
horas** — no hay ningún botón.

Categorías (barra de la raíz `/`):

- 🟦 **Sistema** (`/usr`, `/boot`, `/etc`, `/lib`...)
- 🟩 **Aplicaciones** (Flatpak, Snap, `/opt`)
- 🟧 **Archivos de usuario** (`/home`)
- 🟪 **Temporales y caché** (`/tmp`, `/var/tmp`, `/var/cache`)
- 🟥 **Registros** (`/var/log`)
- ⬜ **Otros / sin clasificar**

La **leyenda de colores** aparece en horizontal en la **parte inferior** del
menú. Al **pasar el cursor** sobre cualquier segmento se muestra un tooltip con
la **categoría y su porcentaje**.

En unidades de datos (no la raíz) el desglose se hace por **carpetas de nivel
superior**. Notas: la clasificación es **heurística por carpetas** y lo que
requiera privilegios de root que no se pueda leer se contabiliza en «Otros».

## Instalación

### Opción A — desde el archivo `.zip`

```bash
gnome-extensions install --force disk-ram-monitor@felipe.zip
gnome-extensions enable disk-ram-monitor@felipe
```

Luego reinicia GNOME Shell:

- **Wayland:** cierra sesión y vuelve a entrar (obligatorio; no se puede recargar en caliente).
- **X11:** `Alt`+`F2`, escribe `r`, Enter.

### Opción B — copiando los archivos

```bash
mkdir -p ~/.local/share/gnome-shell/extensions/disk-ram-monitor@felipe
cp -r metadata.json extension.js stylesheet.css \
  ~/.local/share/gnome-shell/extensions/disk-ram-monitor@felipe/
gnome-extensions enable disk-ram-monitor@felipe
```

…y reinicia GNOME Shell como se indica arriba.

## Compatibilidad

Requiere GNOME Shell 45 o superior (usa módulos ESM). Comprueba tu versión con:

```bash
gnome-shell --version
```

## Configuración

Algunos valores se pueden ajustar al inicio de `extension.js`:

- `REFRESH_SECONDS` — frecuencia de actualización (por defecto 3 s).
- `BAR_WIDTH` — ancho de las barras en píxeles.

Los colores están en `stylesheet.css`.

## Licencia

MIT — ver [LICENSE](LICENSE).
