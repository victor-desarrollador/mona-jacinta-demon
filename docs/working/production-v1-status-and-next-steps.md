Mona Jacinta Production V1 — Estado del Proyecto y Próximos Pasos

Fecha de corte: 2026-09-14
Rama activa: feat/production-v1
Estado del working tree al cierre: limpio
Objetivo: dejar un checkpoint operativo y técnico para retomar el proyecto sin perder decisiones, contexto ni pendientes.

1. Resumen ejecutivo

Mona Jacinta ya dejó atrás Demo V2 como referencia principal. El proyecto está en Production V1, con la base organizacional y de autorización migrándose de forma controlada hacia el modelo definitivo.

Backend actual:

Express

TypeScript

Prisma 7

PostgreSQL

Supabase PostgreSQL alojado

Vitest + Supertest

Socket.IO

JWT

Prioridad permanente:

data integrity > security > business rules > traceability > architecture > tests > performance > UX > aesthetics

2. Checkpoints Git importantes

Phase 1B — RBAC Production foundation

5fd4048 — feat: add Production V1 RBAC scope foundation

Base de:

roles Production

permisos Production

UserRoleScope

constraints de scope

coexistencia temporal con estructuras legacy

Phase 1C — Switch de autoridad de ubicación

7d0c2b6 — feat: switch legacy branch scopes to UserRoleScope

Gate final:

37 / 37 test files PASS

310 / 310 tests PASS

VITEST_EXIT=0

duración aproximada: 58m 41s

OpenCode audit completado

Claude Code TDD/runtime fixes completados

Codex review independiente: 0 blockers

DEV no fue tocado

Contexto para agentes actualizado

d48c622 — docs: refresh AI development context

Incluyó:

AGENTS.md actualizado y reducido

CLAUDE.md creado

contexto Demo V2 obsoleto removido de la ruta principal

workflow de agentes y seguridad centralizados

Security guidance del proyecto

997645c — docs: add project security guidance

Agregó:

.claude/claude-security-guidance.md

con reglas específicas para autorización, scopes, privilegios y seguridad de DB.

3. Arquitectura actual

El repo contiene:

api/

client/

admin/

docs/

.claude/

graphify-out/

El legacy de referencia vive en ../Tesis/ y es READ-ONLY.

Backend:

PostgreSQL es source of truth.

Express + Prisma son la frontera autorizada de acceso a datos.

No hay frontend → Supabase directo.

Supabase se usa como infraestructura PostgreSQL.

4. Entornos de base de datos

DEV

DATABASE_URL

Uso:

desarrollo

demo

pruebas manuales no destructivas

Regla:

Nunca resetear, truncar, backfillear o modificar destructivamente DEV sin aprobación humana explícita.

TEST

TEST_DATABASE_URL

Uso:

integration tests

fixtures destructivos

resets

validación de backfills

Los tests destructivos deben fallar cerrado si no pueden demostrar que apuntan a TEST.

5. Roles Production definitivos

Los únicos roles Production V1 son:

OWNER

ADMIN

CASHIER

SELLER

WAREHOUSE

MANAGER:

no es un rol Production

existe sólo como compatibilidad legacy

se mapea explícitamente a WAREHOUSE

nunca debe inferirse heurísticamente

6. Modelo objetivo de autorización

OWNER

Scope: COMPANY

autoridad total

operaciones OWNER-only

administración completa

ADMIN

Scope: COMPANY

acceso operacional a todas las sucursales

acceso al depósito central

administración de usuarios/scopes

casi toda la autoridad operacional

Restricciones:

no puede escalar a OWNER

no puede otorgar OWNER

no puede ejecutar acciones OWNER-only

CASHIER

Scope: LOCATION

caja

POS

cobros

apertura/cierre según permisos

SELLER

Scope: LOCATION

ventas

borradores

envío a caja

WAREHOUSE

Scope: LOCATION

inventario

depósito

movimientos de stock

7. Reglas de asignación

OWNER y ADMIN pueden:

asignar locations

reasignar locations

ampliar/revocar scopes

La reasignación cambia UserRoleScope, no el rol.

Reglas:

CASHIER no puede autoasignarse.

SELLER no puede autoasignarse.

WAREHOUSE no puede autoasignarse.

revocaciones deben reflejarse desde estado persistido actual.

nunca confiar en branch/location IDs del cliente sin autorización server-side.

Diseño futuro a considerar:

impedir reasignar CASHIER con caja abierta

múltiples locations cuando el negocio lo requiera

separar authorized locations de active/current location

8. Phase 1A — Company / Location

Introdujo:

Company

Location

Invariante crítica:

Location.id = Branch.id

La empresa se mantiene single-company por ahora.

Sucursales y depósito central se representan como Location.

9. Phase 1B — RBAC foundation

Introdujo:

catálogo de roles Production

33 permisos Production uppercase

UserRoleScope

ScopeKind.LOCATION

ScopeKind.COMPANY

constraints e índices de integridad

Se conservaron temporalmente:

permisos legacy lowercase

UserBranchRole

MANAGER

10. Phase 1C — completada

Resultado clave:

UserRoleScope es la autoridad de location scope.

Reglas:

UserRoleScope = autoridad de locations

UserBranchRole no otorga location access

empty UserRoleScope = cero locations

no hay fallback legacy

stale UserBranchRole no puede otorgar ni vetar location access

COMPANY sigue fail-closed

UserBranchRole queda sólo por compatibilidad de role/permission legacy

Áreas runtime corregidas:

sales cancellation

payments

complete sale

cash

Socket.IO room assignment

auth branchIds

login branchIds

tests de revocación/reasignación

Socket.IO

Actualmente:

scopes correctos al conectar

rooms derivadas de UserRoleScope

una conexión abierta conserva snapshot hasta reconectar

Esto queda como deuda técnica futura.

11. Infraestructura de tests

Se agregó cleanup controlado de factory Locations:

api/tests/globalSetup.ts

api/tests/helpers/factory-cleanup.ts

Objetivo:

evitar acumulación de Locations

conservar Company canónica

mantener TEST determinista

La full suite no estaba colgada: era lenta.

Causa:

PostgreSQL TEST remoto

~100 ms por roundtrip

muchos awaits secuenciales en fixtures

fileParallelism=false

Gate recomendado:

NODE_ENV=test npx vitest run --reporter=verbose

12. Deudas técnicas conocidas

Test DB pool lifecycle

createTestPrismaClient() crea un pg.Pool cuyo ownership/lifecycle no está resuelto de forma ideal.

Revisar:

prisma.$disconnect()

pool.end()

ownership por test file

Warning pg

Warning conocido:

Calling client.query() when the client is already executing a query is deprecated

No bloqueó Phase 1C.

Socket authorization snapshot

Scopes de sockets conectados no se revocan en caliente hasta reconnect.

Backoffice users

Hay presentación/organización residual basada parcialmente en UserBranchRole.

Test performance

Fixtures realizan demasiadas queries secuenciales remotas.

Posible optimización futura:

batching

transacciones de setup

factories más eficientes

No optimizar antes de correctness/security.

13. Herramientas configuradas

Claude Code

Rol: implementador principal controlado.

Superpowers

Activo.

Skills relevantes:

systematic-debugging

test-driven-development

verification-before-completion

security-guidance

Plugin oficial de Claude Code: instalado y enabled.

Reglas del proyecto:

.claude/claude-security-guidance.md

Graphify

Instalado/configurado.

Evidencia:

graphify-out/

graph.json

manifest.json

Uso recomendado:

exploración de dependencias

mapas de impacto

navegación transversal

OpenCode

Rol: auditor transversal read-only.

Codex

Rol: review independiente de alta rigurosidad antes del gate final.

claude-mem / memoria

Uso:

orientación histórica

Nunca reemplaza:

código actual

Git

documentación autoritativa

14. Contexto persistente para agentes

AGENTS.md

Contiene:

arquitectura

roles

invariantes

DB safety

workflow

prioridades

Fue reducido de ~1705 a ~231 líneas.

CLAUDE.md

Contiene:

instrucciones de Claude Code

orden de lectura

testing policy

reglas de Git

uso de Superpowers

Aproximadamente 94 líneas.

docs/production-v1/*

Es la fuente de verdad de requisitos y arquitectura.

Regla:

requirements > legacy code

No modificar docs congelados para hacerlos coincidir con una implementación incorrecta.

15. Workflow obligatorio

Para cambios relevantes:

inspeccionar completamente el área afectada

encontrar patrones equivalentes

systematic-debugging para defectos

TDD para cambios de comportamiento

implementación mínima coherente

focused tests

review completo del diff

review independiente en cambios críticos

full suite sólo como gate final

Nunca:

dos agentes editando el mismo tree a la vez

reset/revert destructivo

commit/push sin instrucción

tocar DEV sin permiso

reescribir una migración aplicada

16. Política de tests

Durante implementación:

cd api
NODE_ENV=test npx vitest run tests/<archivo>.test.ts --reporter=verbose

Static gates:

npm run lint
npx tsc --noEmit
npm run build
git diff --check

Full suite sólo al final:

NODE_ENV=test npx vitest run --reporter=verbose

17. Próxima fase — Phase 1D

Objetivo

Completar el switch a autorización Production.

Resultado objetivo:

UserRoleScope + Production permissions

como autoridad completa.

Debe desaparecer la dependencia runtime de:

permisos legacy lowercase

role-name bypasses

autoridad residual de UserBranchRole

Áreas a auditar

middleware/auth.ts

middleware/authorization.ts

auth.service.ts

rutas/middlewares de permisos

backoffice

sales

payments

cash

inventory

products

audit

realtime/socket

user management

role assignment

permission resolution

company/location scope resolution

Preguntas a cerrar

¿Cómo se resuelve OWNER?

¿Cómo se resuelve ADMIN COMPANY-wide?

¿Cómo se separan OWNER-only actions?

¿Cómo se reemplazan permisos lowercase?

¿Cuándo deja UserBranchRole de participar en autorización?

¿Cómo se asigna/reasigna un empleado?

¿Qué endpoint gestiona UserRoleScope?

¿Qué controles impiden privilege escalation?

¿Cómo se maneja active/current location?

¿Cómo se sincronizan sockets luego de scope changes?

¿Qué compatibilidad queda temporalmente?

¿Cuál es el criterio para deprecar/remover UserBranchRole?

Orden recomendado

auditoría read-only

mapa completo del authorization surface

plan aprobado

TDD

implementación

focused gates

security-guidance review

OpenCode transversal audit

Codex final review

full suite

commit/push

18. Regla de migración permanente

ADD → BACKFILL → VERIFY → SWITCH → DEPRECATE → REMOVE

Nunca:

reemplazar todo de golpe

borrar compatibilidad antes del switch

reescribir migración aplicada

confiar en inferencias ambiguas

eliminar datos legacy sin verificar equivalencia

19. Qué NO hacer ahora

Antes de Phase 1D no conviene:

instalar muchas más herramientas

integrar LightRAG sin necesidad concreta

meter otro framework de agentes

optimizar test performance antes de correctness

tocar client/admin sin auditar su estado Production

rediseñar UI

empezar otra fase mientras autorización no esté cerrada

Foco actual:

cerrar correctamente el modelo de autorización Production.

20. Estado actual para retomar

branch: feat/production-v1
HEAD: 997645c
origin/feat/production-v1: 997645c
working tree: clean

Últimos commits:

997645c docs: add project security guidance
d48c622 docs: refresh AI development context
7d0c2b6 feat: switch legacy branch scopes to UserRoleScope

Phase 1C:

CLOSED / GREEN

Próximo trabajo:

Phase 1D — Production Authorization Switch

21. Frase de recuperación rápida

Mona Jacinta está en Production V1. Phase 1C está cerrada y UserRoleScope ya es la autoridad de location scope. El siguiente objetivo es Phase 1D: completar la autorización Production usando los cinco roles definitivos, COMPANY/LOCATION scopes y permisos Production, eliminando la dependencia runtime de autoridad legacy sin tocar DEV ni romper compatibilidad antes de tiempo.