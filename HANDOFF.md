# HANDOFF - ProgramadorCQ

Resumen tecnico vivo del proyecto **ProgramadorCQ** (programacion visual de produccion por linea).
Antes de continuar, leer este archivo + `README.md` + `package.json` + el codigo relacionado.

## Que es

App **separada** de ProgramacionCQ que **comparte la misma base Supabase y el mismo login**.
Es un **Gantt semanal por linea** (L0/L1/L2/TM): se arrastran las WOs de JDE pendientes a un dia
y se programan en una linea. Casi toda la logica esta en `app/page.tsx` + helpers en `lib/`.

## Forma de trabajo

- Repo GitHub: **`https://github.com/Lautaro1418/ProgramadorCQ`** (privado, dueno `Lautaro1418`).
- Carpeta local de trabajo: **`C:\Users\sualau\ProgramadorCQ`** (clon de GitHub; NO trabajar en la copia
  de SharePoint `...\TABLERO PROGRAMACION\ProgramadorProduccion`, que quedo congelada).
- Flujo: editar local -> `git push origin main` -> **Vercel** redeploya solo.
- **Identidad git**: la maquina la tiene vacia; se commitea con
  `git -c user.name="Lautaro Emanuel Suarez" -c user.email="lautaro.suarez@grupopenaflor.com.ar"`.
  Importante por Vercel Hobby: el commit de cabecera (el que deploya) debe ser de Lautaro, no de Marcos.
- **`.env.local`** (no en git) = las 2 vars `NEXT_PUBLIC_SUPABASE_URL` / `ANON_KEY` (mismas que
  ProgramacionCQ, proyecto `enmfghqzrnichfrwrobc`). NO incluir el `service_role`.

## Comandos (Node portable; npm no siempre esta en PATH)

```powershell
$env:Path='C:\Users\sualau\node\node-v24.15.0-win-x64\node-v24.15.0-win-x64;' + $env:Path
cd C:\Users\sualau\ProgramadorCQ
npm run dev      # localhost:3000
npm run build    # valida (anda offline: no usa next/font/google)
```
- **Validacion**: `tsc --noEmit` + `next build`. Ambos OK.
- **`npm run lint` esta ROTO** (preexistente de Marcos: ESLint 9 flat-config + `eslint-config-next`
  -> "Converting circular structure to JSON"). **No afecta el build/deploy** (Next 16 + Turbopack no
  corre ese eslint en build). Pendiente arreglarlo en otra pasada.

## Stack
Next.js 16.2.6 (Turbopack) · React 19 · Tailwind 4 · `@supabase/supabase-js`. Sin `next/font/google`.

## Tablas Supabase que usa
- **Lee**: `perfiles` (auth) + `categorias_usuario`/`categoria_permisos` (rol, a portar en F1),
  `ope_ordenes` (backlog), `velocidades_botella` (velocidad), `producciones_insumos` (botella IFR por WO).
- **Lee/Escribe**: `produccion_programada` (el programa: insert al programar, delete al quitar,
  update al ajustar/recalcular). `linea_edicion` (lock por linea, F1).
- No escribe a JDE.

### Migraciones ya corridas en Supabase (estan en `migrations/`)
- `produccion_programada.sql` — tabla base del Gantt (ya existia).
- `cajas_ajustado` — `alter table produccion_programada add column if not exists cajas_ajustado numeric;` (Lote 1b).
- `linea_edicion` — tabla del lock por linea (F1). Falta activar Realtime de esa tabla en
  Database -> Replication cuando se cablee.

## Logica de calculo (`lib/duracion.ts`)
`minutos = (cajas_efectivas x botellas_por_caja) / botellas_hora x 60 + setup`.
- `botellas_hora` <- `velocidades_botella` por `(codigo botella IFR | tipo | linea)`; botella IFR <-
  `producciones_insumos`; tipo: ISEA->vestido, resto->directo. Defaults: 9000 bot/h, 6 bot/caja, **setup fijo 30 min**.
- **Bug conocido**: `insumoActivo` nunca se llena -> el tipo siempre cae en 'directo' (las velocidades
  'vestido' no se usan). A corregir.

---

## Estado actual — lo hecho (mas nuevo arriba)

- **Lote 1b** (commit `5a3c231`): **cajas editable por bloque**. En el popover del bloque hay un editor
  (input + Ajustar + ↺). Visual: cantidad de sistema **tachada** + ajustada mas grande con **flecha ↑/↓**
  (ambar sube / verde baja), en el bloque y el popover. Al ajustar se **recalcula la cadena del dia**
  (`recalcCadena`: cada bloque arranca donde termino el anterior). **Merge**: en la carga, si el sistema
  (`ope_ordenes.cajas_jde`) cambio la cantidad de una WO programada, se descarta el ajuste y queda la de
  sistema. Modelo: `produccion_programada.cajas` = sistema, `cajas_ajustado` = manual (null=sistema),
  efectiva = `cajas_ajustado ?? cajas`.
- **Lote 1a** (commit `46e5baf`): **pantalla completa** · backlog **estado >= 40 y != 99** (oculta <40 y
  canceladas) · **click en bloque = popover** con la info · **quitar = ✕ al pasar el mouse + doble-click**.
- **Setup inicial**: repo clonado a local, `.env.local`, `npm install`, baseline OK.

---

## Objetivo general / SPEC (lo que pidio Lautaro)

App para **programar las 4 lineas** (L0, L1, L2, TM=tareas manuales). Funcionalidad buscada:
ver una semana y que tan llena esta, distribucion de codigos de vino, % de uso por linea, y el tiempo
de **cambio de formato** entre ordenes visible.

### Acceso y roles
- Al entrar, **elegir a que linea** entrar.
- **PROGRAMADOR = Admin** de ProgramacionCQ (`isAdmin = permisos['configuracion']?.puede_ver`). El alta
  de usuarios/permisos se sigue manejando desde la web original. **VISITA** = el resto (solo mira).
- **Lock por linea**: 1 solo programador editando una linea a la vez; se muestra **quien**. Un programador
  puede tener varias lineas tomadas. Lock con **heartbeat de 10 min** (si cierra la pestana, se libera solo).
- **Realtime**: todos ven **solo el OFICIAL**; mientras un programador edita, su borrador es privado;
  al **Plasmar**, Realtime actualiza la pantalla del resto. El cartel "la edita Fulano" tambien por Realtime.
  > El lock decide quien toca; Realtime hace que el resto VEA el resultado al instante.

### Borrador / Plasmar
- Hay un programa **oficial** (lo que ven todos). El programador trabaja sobre un **borrador** que
  autoguarda en cada cambio. Boton **"Plasmar Programa"** -> el borrador pasa a oficial.

### Capacidad / turnos (config por linea, editable desde la pagina de la linea, por semana)
- **% paradas operativas** y **% paradas externas** por linea (editables).
- **L1 y L0**: elegir **3 turnos** (8h c/u = 24h, lunes 06:00 -> **sabado 13:00**) o **4 turnos** (24h
  lunes a domingo).
- **L2 y TM**: elegir **manana** (Lun-Vie 06-14 + **Sab 06-13**) o **tarde** (Lun-Vie 14-22, sin sabado).
- `capacidad efectiva = horas_disponibles x (1 - %paradas_op - %paradas_ext)`;
  `% uso = minutos_programados / capacidad efectiva`. (A confirmar fino.)

### Setups visuales
- Setup entre 2 ordenes = **el MAXIMO** de los componentes (formato/color/azucar/velcorin/etiqueta/caja/
  vino), igual que el Optimizador de ProgramacionCQ. Mostrar en el hueco entre ordenes el tiempo **+ una
  etiqueta** de cual componente manda (ej. "45 min · cambio de formato").
- Restricciones de formato por linea: **pendiente** (Lautaro va a pasar mas detalle).

### Boton Actualizar
- Arriba, dispara el **mismo sync** que ProgramacionCQ (via `refresh_log` + watcher), ajustando lo necesario.

### Datos disponibles (tablas Supabase)
`ope_ordenes` (orden basica: orden/estado/descripcion/planta/fe_solicitada/cajas_jde/cod_item_largo;
alcohol y cosecha vienen NULL). `producciones` (insumo activo por orden; sin filtro trae todos los insumos).
`producciones_insumos` (botella -> formato). Estaticas: `producto_atributos`, `setup_*`,
`velocidades_botella`, `insumo_formato`, `vino_equivalencias`, `codigos_vinos`.
Buena parte de la logica pesada (setups reales, enriquecimiento botella/formato/velocidad, boton Actualizar)
**ya existe en ProgramacionCQ y se puede portar**.

---

## Roadmap

- **Lote 1a** ✅ — UX base (pantalla completa, filtro estado, click=info, quitar ✕+doble-click).
- **Lote 1b** ✅ — cajas editable + merge.
- **F1** (EN CURSO) — selector de linea al entrar + roles Admin/Visita + lock por linea (heartbeat 10min) +
  Realtime del indicador "quien edita". (Decision UX: pantalla de seleccion de linea a pantalla completa.)
- **F2** — borrador/oficial + boton "Plasmar Programa".
- **F3** — enriquecimiento + setups reales (portar del optimizador).
- **F4** — visual: gap de setup entre ordenes, % de uso por linea (paradas + turnos), vista semanal +
  distribucion de vinos.
- **F5** — boton Actualizar (sync) + ajustes al script.
- Deuda: fix `npm run lint`; bug del tipo directo/vestido (`insumoActivo` vacio); restricciones de formato por linea.

## Regla de actualizacion
Cada tanda relevante: actualizar "Estado actual" + commits + migraciones corridas + validaciones + proximos pasos.
