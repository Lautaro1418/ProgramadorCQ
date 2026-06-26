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

## Acciones manuales pendientes (las corre Lautaro en Supabase)

**Ya corridas por Lautaro (2026-06-26):** `capacidad_linea.sql` (F4), `borrador.sql` (F2),
`linea_edicion.sql` (F1b) + Realtime de `linea_edicion` activado.

**Falta correr (SQL Editor):**
- `migrations/realtime_programa.sql` — Realtime del programa oficial, para que el resto vea el "Plasmar"
  al instante. Es `alter publication supabase_realtime add table produccion_programada` (idempotente).
  Sin esto, F2 funciona igual pero el resto ve el plasmado al recargar / con Actualizar.

**3) Probar** (idealmente con 2 usuarios admin): entrar a la misma línea (el 2º ve 🔒 + "la edita Fulano"),
tocar turno/paradas y ver el % de uso, y el flujo **borrador → "Plasmar Programa"** (el resto ve el oficial
hasta que plasmás). Si algo del borrador se ve raro al entrar muy rápido a una línea, "Descartar" lo resetea.

## Estado actual — lo hecho (mas nuevo arriba)

- **F2** (borrador / Plasmar): cada línea tiene un **programa oficial** (lo ven todos) y, para el programador
  que la edita, un **borrador privado**. Al tomar el lock se **forkea** el oficial→borrador (`ensureDraft`);
  los cambios (drag/mover/ajustar/quitar) van al borrador y **el resto sigue viendo el oficial**. Botón
  **"Plasmar Programa"** promueve borrador→oficial (y re-forkea uno fresco para seguir editando); **"Descartar"**
  vuelve al oficial. **Seguro por capability-flag**: si la columna `estado` NO existe (antes de la migración),
  `draftEnabled=false` y la app se comporta EXACTAMENTE como antes (cero ruptura). `programadasVisible` decide por
  línea si mostrar borrador (la edito yo, con lock) u oficial. Migración **`migrations/borrador.sql`**.
  **Realtime del oficial HECHO**: al **Plasmar**, el resto lo ve al instante (efecto que escucha
  `produccion_programada`, ignora cambios de borrador y de las líneas propias para no interrumpir; reload
  debounce 800ms). Requiere correr **`migrations/realtime_programa.sql`** (suma la tabla a `supabase_realtime`).
  La ventana de carrera del fork al entrar a una línea quedó **endurecida**: `programar` asegura el borrador
  antes de agregar.
- **F5** (botón Actualizar): `components/RefreshButton.tsx` arriba a la derecha; inserta en `refresh_log`
  (status 'pendiente') que el watcher (sync) levanta, y al completar recarga (`onComplete=cargar`). **Sin migración**
  (refresh_log ya existe en la base compartida).
- **F4** (capacidad): tabla `capacidad_linea` (linea, semana=lunes ISO, turno, paradas_op/ext). Panel arriba con
  selector de **turno** (L1/L0: 3T lun→sáb13 / 4T lun→dom; L2/TM: mañana+sáb / tarde), inputs de **% paradas**
  op/ext y barra de **% de uso de la semana** (minutos programados / capacidad efectiva = horas_turno × (1−paradas)).
  Editable solo por el programador con el lock. Migración **`migrations/capacidad_linea.sql`**.
- **F3** (setups reales): la banda entre órdenes ahora es el **cambio real = el MÁXIMO de los componentes**
  (formato / etiqueta / velcorin / azúcar / caja / cambio de vino) con la **etiqueta del que manda**
  (ej. "⚙ 45m · formato"). Portado del Optimizador de ProgramacionCQ → **`lib/setups.ts`**: `buildSetupMaps`
  carga las tablas `setup_*` + `producto_atributos` / `insumo_formato` / `vino_equivalencias` y **deriva los
  atributos por orden** (nFormato por IFR→insumo_formato, color/velcorin/azúcar/caja, wineKey vía
  vino_equivalencias); `setupEntre(prevWo, wo, linea, maps)` aplica la regla del máximo y devuelve `{min,label}`.
  El setup se **recomputa en la cadena** según la orden previa (`recalcCadena` ahora recibe `SetupMaps`), así
  que **al reordenar/mover el setup se recalcula bien** (antes quedaba el del momento de programar). En la carga
  se recomputan todos los días **en memoria** (corrige el setup fijo viejo de 30m); cada edición persiste su día
  (incluido `setup_min`). La etiqueta también aparece en el popover. **Sin migración** (las `setup_*` ya existen).
  Centinela `>=900` de `setup_formato` (formato infactible) se ignora para no romper el layout — las
  **restricciones de formato por línea siguen pendientes** (Lautaro pasará el detalle).
- **F1b** (lock por línea): solo **1 programador edita una línea a la vez** (tabla `linea_edicion`,
  esquema en `migrations/linea_edicion.sql`). Al entrar a una línea el admin **toma el lock**; **heartbeat
  cada 3 min**, vence a los **10 min** sin refresco; se **libera** al salir/cerrar (best-effort + TTL).
  `puedeEditar = isAdmin && !lockDeOtro(linea)`. Indicadores: badge **"Editás vos"** (admin libre) /
  banner **"La está editando Fulano"** + **🔒** en la pestaña de la línea tomada por otro. Sync por
  **Realtime** (`postgres_changes` de `linea_edicion`) **+ poll de respaldo cada 30s** (anda aunque
  Realtime no esté activo). **Pendiente del usuario**: activar **Realtime de `linea_edicion`** en Supabase
  → Database → Replication (sin eso el indicador se actualiza por el poll de 30s, no instantáneo).
- **Lote 2** (visual + mover bloques):
  - **Bloques rediseñados**: N° de orden grande, **SKU** (`cod_item_largo`) y **duración** (`fmtDur`,
    en vez del horario) siempre visibles; **borde marcado**; **banda de setup** arriba de cada orden
    (rayada, con los minutos = "tiempo entre órdenes"; hoy usa el setup fijo, con **F3** será el real por
    componente). SKU + código de vino se cargan **en memoria** al leer (`ope_ordenes.cod_item_largo` +
    `producciones.insumo` → `codEqDeInsumo`), NO requieren columnas nuevas.
  - **Agrupado por vino**: órdenes **consecutivas del mismo vino** quedan encerradas por un **borde de
    color** (`gruposVino` + `colorDeVino`, color determinista por código).
  - **Mover bloques (drag)**: un bloque programado ahora es **arrastrable** (solo PROGRAMADOR). Soltar en
    **otro día** lo mueve (se agrega al final de ese día); soltar **sobre otra orden** lo inserta **antes**
    de ella (reordenar, mismo día o entre días). `moverBloque(blockId, targetFecha, beforeId)` reordena
    `orden_en_dia`, **recalcula la cadena** de los días afectados (`recalcCadena`) y persiste. NOTA: el
    posicionamiento es **por orden** (las horas se recalculan en cadena desde las 06:00); NO es tiempo
    libre arbitrario (eso sería otro modelo).
  - **Pendiente que pidió Lautaro y es de fases siguientes**: el **% de uso / turno editable / % paradas**
    es **F4** (capacidad) — todavía no existe, por eso no se ve. El **setup real por la regla del máximo**
    (formato/color/azúcar/etc. con etiqueta de cuál manda) es **F3**.
- **F1a** (acceso, parte 1): **AuthContext con roles** (port de ProgramacionCQ: `isAdmin = permisos['configuracion'].puede_ver`)
  + **pantalla de seleccion de linea al entrar** (`SelectorLinea`) + **gating por rol**: VISITA solo lee (sin drag,
  sin ✕ para quitar, sin editor de cajas), PROGRAMADOR edita. `linea` ahora es `Linea | null` (null = pantalla de
  seleccion; boton ⟵ vuelve a elegir). Hoy `puedeEditar = isAdmin`. Falta **F1b**: lock por linea + heartbeat + Realtime.
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
- **F1a** ✅ — selector de linea al entrar (pantalla completa) + roles Admin/Visita (port de permisos) + read-only por rol.
- **F1b** ✅ — lock por linea (`linea_edicion`, heartbeat 3min / TTL 10min) + Realtime + poll 30s + indicadores
  ("Editás vos" / "La edita Fulano" / 🔒 en la pestaña). `puedeEditar = isAdmin && !lockDeOtro(linea)`.
  **Pendiente del usuario**: activar Realtime de la tabla en Supabase → Database → Replication.
- **F2** ✅ — borrador/oficial + botón "Plasmar Programa" (capability-flag por columna `estado`; `migrations/borrador.sql`)
  + **Realtime del oficial** (`migrations/realtime_programa.sql`) para ver el plasmado al instante.
- **F3** ✅ — setups reales (máximo de componentes + etiqueta) en `lib/setups.ts`, recomputados en la cadena.
  Falta: restricciones de formato por línea (el centinela 9999/`>=900` hoy se ignora).
- **F4** ✅ (capacidad) — turnos + % paradas + **% de uso por línea/semana** (`migrations/capacidad_linea.sql`).
  Falta (follow-up): vista semanal agregada + distribución de vinos por semana.
- **F5** ✅ — botón Actualizar (dispara el sync vía `refresh_log`, `components/RefreshButton.tsx`).
- Deuda: fix `npm run lint`; bug del tipo directo/vestido (`insumoActivo` vacio); restricciones de formato por linea.

## Regla de actualizacion
Cada tanda relevante: actualizar "Estado actual" + commits + migraciones corridas + validaciones + proximos pasos.
