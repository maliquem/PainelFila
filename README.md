# Painel da fila

Duas peças que dividem a pasta `%LOCALAPPDATA%\fila-build`:

- `fila/fila-build.ps1`: a fila de builds numerada (instalada em `~/.claude/scripts/fila-build.ps1`).
- `plugin/`: o mod `painel-fila` do Claude Code, com o painel `/fila` e a publicação das tarefas de fundo de cada sessão.

## Fila

```powershell
pwsh -NoProfile -File ~/.claude/scripts/fila-build.ps1 -Nome <sessão> [-Tipo <tipo>] [-Sozinho] <comando> [args...]
```

- No máximo duas vagas. `-Sozinho` ocupa as duas (Medição).
- Sem `-Tipo`, o tipo vem do comando: cargo/cmake/ninja → Build, test/ctest/pytest → Teste, jogo-oculto/--hidden-window → Jogo.
- O código de saída do comando volta igual. A saída vai também para `logs\<id>.log`.
- Controles (o painel usa estes): `-Mover <id> topo|cima|baixo`, `-Cancelar <id>`, `-Pausar`, `-Soltar`, `-Limpar`.
- Respeita as vagas `lock`/`lock2` da versão antiga enquanto existirem.

Arquivos em `%LOCALAPPDATA%\fila-build` (ou `$env:FILA_BUILD_DIR`): `fichas\<id>.json`, `ordem.txt`, `pausa`, `logs\`, `historico.jsonl` e `sessoes\<sessão>.json` (do mod).

Teste: `pwsh -NoProfile -File fila/teste-fila.ps1` (usa uma pasta temporária, não mexe na fila de verdade).

## Painel

O painel abre sozinho no começo de toda sessão. Se for fechado, `/fila` abre de novo. Ele mostra:

- **Rodando**: tipo, sessão, comando, há quanto tempo e o tempo estimado (média das últimas 5 do mesmo tipo e pasta). Tem os botões Matar e Log.
- **Na fila**: a posição, com os botões ↑, ↓, Topo e Cancelar.
- **Outras tarefas de fundo**: comandos em segundo plano, subagentes e monitores de todas as sessões abertas.
- **Pausar fila / Soltar fila**: enquanto pausada, nenhum pedido novo começa.

Quando algo da fila termina, aparece um aviso com o código de saída. O aviso sai na sessão dona do pedido e em toda sessão que estiver com o painel aberto (por padrão, todas).

Testes do mod: `claude plugin validate plugin` e `claude plugin test plugin`.

## Instalar e reinstalar

Do GitHub, numa sessão do Claude Code:

```
/plugin marketplace add maliquem/PainelFila
/plugin install painel-fila@painel-fila-local
```

A fila (`fila/fila-build.ps1`) é copiada à mão para `~/.claude/scripts/`.

De uma cópia local:

```powershell
claude plugin marketplace add K:\src\PainelFila
```

```powershell
claude plugin install painel-fila@painel-fila-local --scope user
```

O mod é lido direto de `K:\src\PainelFila\plugin`. Depois de editar, rode `/reload-plugins` em cada sessão aberta. Sessões novas já carregam a versão nova.
