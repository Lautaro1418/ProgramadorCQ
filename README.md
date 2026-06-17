# Programador de Producción

App de programación visual (Gantt semanal) de producción por línea para Fraccionamiento CQ — Grupo Peñaflor.

Usa la **misma base de datos Supabase** que ProgramacionCQ (mismo login de usuarios). Es un repositorio y proyecto de Vercel **separados**.

## Qué hace

- Una **pestaña por línea**: L1, L2, L0, TM.
- **Backlog** de WOs de JDE (`ope_ordenes`, estado 40/41/45, semana actual + siguiente) sin programar.
- Se **arrastra** una WO a un día → se programa en la línea activa.
- **Duración automática**: cajas ÷ velocidad de línea (`velocidades_botella`) + setup por cambio de WO.
- Horas libres, una WO puede cruzar la medianoche.
- Se guarda en la tabla `produccion_programada` (no escribe a JDE).

## Setup

```bash
npm install
cp .env.example .env.local   # completar con las credenciales de Supabase de ProgramacionCQ
npm run dev
```

### Migración obligatoria

Ejecutar en el **SQL Editor de Supabase** (misma base que ProgramacionCQ):

- `migrations/produccion_programada.sql` — crea la tabla con RLS.

## Stack

Next.js 16.2.6 · React 19 · Tailwind 4 · Supabase. Sin `next/font/google` (evita la dependencia de red en el build).

## Variables de entorno (Vercel)

| Variable | Valor |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | mismo que ProgramacionCQ |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | mismo que ProgramacionCQ |

## Pendientes / próximos pasos

- **Setup real**: hoy el setup entre WOs es un valor fijo (`DEFAULT_SETUP_MIN` en `lib/duracion.ts`).
  Falta enchufar la matriz completa (color/formato/velcorin/azúcar/caja) reusando las tablas `setup_*`,
  igual que el Optimizador Makespan de ProgramacionCQ.
- **Botellas por caja**: se asume 6 por defecto. Se puede leer del item/insumo para más precisión.
- **Tipo directo/vestido (ISEA/ISVT)**: hoy se asume `directo` cuando no hay insumo activo cargado.
- **Editar hora de inicio** de un bloque manualmente (hoy se encadenan secuencialmente desde las 06:00).
- **KPIs/OEE** por día (eficiencia, setup %, litros/día) — fase 2.
- **Realtime** para edición concurrente entre usuarios.
