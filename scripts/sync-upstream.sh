#!/usr/bin/env bash
#
# Sincroniza este fork con deepseek-ai/deepseek-harness (ver docs/UPSTREAM_SYNC.md).
#
# Uso:
#   ./scripts/sync-upstream.sh [opciones]
#
# Opciones:
#   -b, --branch <rama>    Rama a sincronizar (por defecto: master)
#   -u, --url <url>        URL del repo original (por defecto: deepseek-ai/deepseek-harness)
#   -r, --rebase           Usa "git rebase" en vez de "git merge"
#   -p, --push             Publica en origin al finalizar sin preguntar
#   -n, --dry-run          Solo hace fetch y muestra cuántos commits faltan, sin modificar nada
#   -h, --help             Muestra esta ayuda
#
# Ejemplos:
#   ./scripts/sync-upstream.sh --dry-run
#   ./scripts/sync-upstream.sh --push
#   ./scripts/sync-upstream.sh --rebase --push

set -euo pipefail

BRANCH="master"
UPSTREAM_URL="https://github.com/deepseek-ai/deepseek-harness.git"
USE_REBASE=0
DO_PUSH=0
DRY_RUN=0

step() { printf '\033[36m==> %s\033[0m\n' "$1"; }
warn() { printf '\033[33m!! %s\033[0m\n' "$1"; }
ok()   { printf '\033[32m%s\033[0m\n' "$1"; }
err()  { printf '\033[31m%s\033[0m\n' "$1" >&2; }

usage() {
    sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        -b|--branch) BRANCH="$2"; shift 2 ;;
        -u|--url) UPSTREAM_URL="$2"; shift 2 ;;
        -r|--rebase) USE_REBASE=1; shift ;;
        -p|--push) DO_PUSH=1; shift ;;
        -n|--dry-run) DRY_RUN=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) err "Opción desconocida: $1"; usage; exit 1 ;;
    esac
done

# 1. Verificar que estamos dentro de un repo git
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    err "Este directorio no es un repositorio git."
    exit 1
fi

cd "$(git rev-parse --show-toplevel)"

# 2. Working tree limpio
if [[ -n "$(git status --porcelain)" ]]; then
    err "Tienes cambios sin commitear. Guarda o descarta tus cambios (git stash / git commit) antes de sincronizar."
    exit 1
fi

# 3. Asegurar remoto "upstream"
if ! git remote | grep -qx "upstream"; then
    step "Agregando remoto 'upstream' -> $UPSTREAM_URL"
    git remote add upstream "$UPSTREAM_URL"
    git remote set-url --push upstream no_push
else
    current_url="$(git remote get-url upstream)"
    if [[ "$current_url" != "$UPSTREAM_URL" ]]; then
        warn "El remoto 'upstream' ya existe pero apunta a '$current_url' (esperado: '$UPSTREAM_URL'). No se modifica."
    fi
fi

# 4. Fetch de upstream
step "Descargando cambios de upstream..."
git fetch upstream --prune --tags

ahead_count="$(git log --oneline "${BRANCH}..upstream/${BRANCH}" | wc -l | tr -d ' ')"
behind_count="$(git log --oneline "upstream/${BRANCH}..${BRANCH}" | wc -l | tr -d ' ')"

echo ""
echo "Commits nuevos en upstream/${BRANCH} no presentes en ${BRANCH} : ${ahead_count}"
echo "Commits propios en ${BRANCH} no presentes en upstream/${BRANCH} : ${behind_count}"
echo ""

if [[ "$ahead_count" -eq 0 ]]; then
    ok "Nada que sincronizar, ${BRANCH} ya está al día con upstream/${BRANCH}."
    exit 0
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
    warn "(--dry-run) No se realizaron cambios. Ejecuta sin --dry-run para integrar."
    exit 0
fi

# 5. Actualizar la rama local con origin antes de integrar
step "Cambiando a la rama '${BRANCH}' y actualizando desde origin..."
git checkout "${BRANCH}"
git pull origin "${BRANCH}"

# 6. Integrar upstream/$BRANCH
if [[ "$USE_REBASE" -eq 1 ]]; then
    step "Integrando upstream/${BRANCH} mediante rebase..."
    integrate_cmd=(git rebase "upstream/${BRANCH}")
else
    step "Integrando upstream/${BRANCH} mediante merge..."
    integrate_cmd=(git merge "upstream/${BRANCH}" --no-edit)
fi

if ! "${integrate_cmd[@]}"; then
    warn "Se encontraron conflictos al integrar upstream/${BRANCH}."
    echo "Resuélvelos manualmente:"
    if [[ "$USE_REBASE" -eq 1 ]]; then
        echo "  1. Edita los archivos en conflicto, luego: git add <archivos>"
        echo "  2. git rebase --continue"
        echo "  (o 'git rebase --abort' para cancelar)"
    else
        echo "  1. Edita los archivos en conflicto, luego: git add <archivos>"
        echo "  2. git commit"
        echo "  (o 'git merge --abort' para cancelar)"
    fi
    exit 1
fi

echo ""
ok "Integración completada sin conflictos."

# 7. Publicar en origin
should_push="$DO_PUSH"
if [[ "$should_push" -eq 0 ]]; then
    read -r -p "¿Publicar '${BRANCH}' actualizado en origin ahora? (s/N) " answer
    if [[ "$answer" =~ ^[sSyY] ]]; then
        should_push=1
    fi
fi

if [[ "$should_push" -eq 1 ]]; then
    step "Publicando '${BRANCH}' en origin..."
    if [[ "$USE_REBASE" -eq 1 ]]; then
        git push origin "${BRANCH}" --force-with-lease
    else
        git push origin "${BRANCH}"
    fi
    ok "Listo: origin/${BRANCH} actualizado."
else
    warn "No se publicó en origin. Revisa los cambios y ejecuta 'git push origin ${BRANCH}' cuando estés listo."
fi
