<#
.SYNOPSIS
    Sincroniza este fork con deepseek-ai/deepseek-harness (ver docs/UPSTREAM_SYNC.md).

.DESCRIPTION
    Agrega/verifica el remoto "upstream", trae los cambios nuevos, los integra
    en la rama local y opcionalmente los publica en "origin" (este fork).

.PARAMETER Branch
    Rama a sincronizar. Por defecto: master.

.PARAMETER UpstreamUrl
    URL del repositorio original. Por defecto: deepseek-ai/deepseek-harness.

.PARAMETER Rebase
    Usa "git rebase" en vez de "git merge" para integrar los cambios de upstream.

.PARAMETER Push
    Publica la rama actualizada en "origin" al finalizar sin pedir confirmación.

.PARAMETER DryRun
    Solo hace fetch y muestra cuántos commits faltan por integrar, sin modificar nada.

.EXAMPLE
    .\scripts\sync-upstream.ps1
    Sincroniza "master" con upstream/master vía merge y pregunta antes de hacer push.

.EXAMPLE
    .\scripts\sync-upstream.ps1 -Push
    Igual que el anterior, pero publica en origin automáticamente al terminar.

.EXAMPLE
    .\scripts\sync-upstream.ps1 -DryRun
    Solo muestra cuántos commits nuevos hay en upstream, sin tocar el repo.
#>

[CmdletBinding()]
param(
    [string]$Branch = "master",
    [string]$UpstreamUrl = "https://github.com/deepseek-ai/deepseek-harness.git",
    [switch]$Rebase,
    [switch]$Push,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

function Write-Step {
    param([string]$Message)
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Warn {
    param([string]$Message)
    Write-Host "!! $Message" -ForegroundColor Yellow
}

function Invoke-Git {
    param([string[]]$GitArgs)
    & git @GitArgs
    if ($LASTEXITCODE -ne 0) {
        throw "git $($GitArgs -join ' ') falló con código $LASTEXITCODE"
    }
}

# 1. Verificar que estamos dentro de un repo git
git rev-parse --is-inside-work-tree *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Error "Este directorio no es un repositorio git."
    exit 1
}

$repoRoot = git rev-parse --show-toplevel
Set-Location $repoRoot

# 2. Working tree limpio
$statusOutput = git status --porcelain
if ($statusOutput) {
    Write-Error "Tienes cambios sin commitear. Guarda o descarta tus cambios (git stash / git commit) antes de sincronizar."
    exit 1
}

# 3. Asegurar remoto "upstream"
$remotes = git remote
if ($remotes -notcontains "upstream") {
    Write-Step "Agregando remoto 'upstream' -> $UpstreamUrl"
    Invoke-Git @("remote", "add", "upstream", $UpstreamUrl)
    Invoke-Git @("remote", "set-url", "--push", "upstream", "no_push")
} else {
    $currentUpstreamUrl = git remote get-url upstream
    if ($currentUpstreamUrl -ne $UpstreamUrl) {
        Write-Warn "El remoto 'upstream' ya existe pero apunta a '$currentUpstreamUrl' (esperado: '$UpstreamUrl'). No se modifica."
    }
}

# 4. Fetch de upstream
Write-Step "Descargando cambios de upstream..."
Invoke-Git @("fetch", "upstream", "--prune", "--tags")

$aheadCount = (git log --oneline "$Branch..upstream/$Branch" | Measure-Object -Line).Lines
$behindCount = (git log --oneline "upstream/$Branch..$Branch" | Measure-Object -Line).Lines

Write-Host ""
Write-Host "Commits nuevos en upstream/$Branch no presentes en $Branch : $aheadCount"
Write-Host "Commits propios en $Branch no presentes en upstream/$Branch : $behindCount"
Write-Host ""

if ($aheadCount -eq 0) {
    Write-Host "Nada que sincronizar, $Branch ya está al día con upstream/$Branch." -ForegroundColor Green
    exit 0
}

if ($DryRun) {
    Write-Host "(-DryRun) No se realizaron cambios. Ejecuta sin -DryRun para integrar." -ForegroundColor Yellow
    exit 0
}

# 5. Actualizar la rama local con origin antes de integrar
Write-Step "Cambiando a la rama '$Branch' y actualizando desde origin..."
Invoke-Git @("checkout", $Branch)
Invoke-Git @("pull", "origin", $Branch)

# 6. Integrar upstream/$Branch
if ($Rebase) {
    Write-Step "Integrando upstream/$Branch mediante rebase..."
    & git rebase "upstream/$Branch"
} else {
    Write-Step "Integrando upstream/$Branch mediante merge..."
    & git merge "upstream/$Branch" --no-edit
}

if ($LASTEXITCODE -ne 0) {
    Write-Warn "Se encontraron conflictos al integrar upstream/$Branch."
    Write-Host "Resuélvelos manualmente:"
    if ($Rebase) {
        Write-Host "  1. Edita los archivos en conflicto, luego: git add <archivos>"
        Write-Host "  2. git rebase --continue"
        Write-Host "  (o 'git rebase --abort' para cancelar)"
    } else {
        Write-Host "  1. Edita los archivos en conflicto, luego: git add <archivos>"
        Write-Host "  2. git commit"
        Write-Host "  (o 'git merge --abort' para cancelar)"
    }
    exit 1
}

Write-Host ""
Write-Host "Integración completada sin conflictos." -ForegroundColor Green

# 7. Publicar en origin
$shouldPush = $Push.IsPresent
if (-not $shouldPush -and -not $DryRun) {
    $answer = Read-Host "¿Publicar '$Branch' actualizado en origin ahora? (s/N)"
    $shouldPush = $answer -match '^[sSyY]'
}

if ($shouldPush) {
    Write-Step "Publicando '$Branch' en origin..."
    if ($Rebase) {
        Invoke-Git @("push", "origin", $Branch, "--force-with-lease")
    } else {
        Invoke-Git @("push", "origin", $Branch)
    }
    Write-Host "Listo: origin/$Branch actualizado." -ForegroundColor Green
} else {
    Write-Host "No se publicó en origin. Revisa los cambios y ejecuta 'git push origin $Branch' cuando estés listo." -ForegroundColor Yellow
}
