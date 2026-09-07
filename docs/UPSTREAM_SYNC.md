# Sincronizar el fork con deepseek-ai/deepseek-harness

Este repositorio (`akenfactory/aken-harness`) es un fork de
[`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness).
Esta guía explica cómo traer los cambios del proyecto original (upstream) a tu
copia local y, desde ahí, subirlos a `origin` (este fork).

## 1. Configuración inicial (ya realizada)

Ya se agregó el remoto `upstream` apuntando al repo original, con el push
deshabilitado para evitar publicar cambios ahí por error:

```bash
git remote add upstream https://github.com/deepseek-ai/deepseek-harness.git
git remote set-url --push upstream no_push
```

Verifica los remotos configurados:

```bash
git remote -v
# origin    git@github.com:akenfactory/aken-harness.git (fetch)
# origin    git@github.com:akenfactory/aken-harness.git (push)
# upstream  https://github.com/deepseek-ai/deepseek-harness.git (fetch)
# upstream  no_push (push)
```

Si clonas este repo en otra máquina, repite esos dos comandos una sola vez.

## 2. Traer los cambios nuevos de upstream

```bash
git fetch upstream --prune
```

Esto descarga las ramas y tags nuevos de `deepseek-ai/deepseek-harness` sin
tocar tu working tree. Para ver cuántos commits nuevos hay disponibles:

```bash
git log --oneline master..upstream/master | wc -l
```

## 3. Traer esos cambios a tu rama `master`

Con el working tree limpio (`git status` sin cambios pendientes):

```bash
git checkout master
git pull origin master          # asegúrate de estar al día con tu propio origin
git merge upstream/master       # trae los commits de upstream
```

- Si no hay conflictos, Git crea un merge commit automáticamente.
- Si hay conflictos, resuélvelos archivo por archivo, luego:

  ```bash
  git add <archivos resueltos>
  git commit
  ```

Alternativa (historial lineal, sin merge commits): usar `rebase` en vez de
`merge`. Solo hazlo si `master` no tiene commits propios que otros ya
hayan bajado, porque reescribe el historial:

```bash
git rebase upstream/master
```

## 4. Publicar los cambios en tu fork (`origin`)

```bash
git push origin master
```

Si usaste `rebase` y ya habías publicado esos commits antes, necesitarás
`git push --force-with-lease origin master` (úsalo con cuidado y solo si
nadie más depende de esos commits).

## 5. Sincronizar una rama de trabajo (feature branch)

Si estás trabajando en una rama basada en una versión antigua de `master`,
después de sincronizar `master` (pasos 2-4) actualiza tu rama:

```bash
git checkout mi-rama
git rebase master        # o: git merge master
```

## 6. Traer solo commits o tags específicos

Si no quieres todo `upstream/master`, puedes traer un commit puntual:

```bash
git cherry-pick <hash-del-commit>
```

O revisar un tag de release de upstream (por ejemplo `dsh-v0.1.3-alpha.2`):

```bash
git fetch upstream --tags
git show dsh-v0.1.3-alpha.2
```

## 7. Comandos de referencia rápida

```bash
git fetch upstream --prune              # trae lo nuevo de upstream
git log --oneline master..upstream/master   # ver qué falta por integrar
git diff master upstream/master -- <archivo>  # ver diferencias en un archivo puntual
git merge upstream/master               # integrar en master
git push origin master                  # publicar en tu fork
```
