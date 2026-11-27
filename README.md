# Painel da fila

Duas peças que dividem a pasta `%LOCALAPPDATA%\fila-build`:

- `plugin/fila/fila-build.ps1`: a fila de builds por pontos (vai junto com o plugin; a cópia em uso fica em `~/.claude/scripts/fila-build.ps1`).
- `plugin/`: o mod `painel-fila` do Claude Code, com o painel `/fila` e a publicação das tarefas de fundo de cada sessão.

## Fila

```powershell
pwsh -NoProfile -File ~/.claude/scripts/fila-build.ps1 -Nome <sessão> [-Tipo <tipo>] [-Peso 1-4] [-Sozinho] <comando> [args...]
```

- Capacidade de 4 pontos. Peso de cada pedido: Build (cargo/cmake/ninja/msbuild/make) 2; Teste com compilação (`cargo test`, nextest, ctest) 2; Jogo (jogo-oculto, --hidden-window) 1; Outro (pwsh, scripts, pytest) 1; `-Sozinho`/Medição 4.
- `-Peso N` (1 a 4) corrige a dedução. Como as outras opções, só vale antes do comando.
- Até 2 pontos em uso entra sem olhar a máquina. Para passar de 2, precisa de CPU total abaixo de 75% (média de uns 5 s) e mais de 4 GB de RAM livre; senão espera. Um pedido sozinho na máquina entra sempre.
- Ordem: quem está na frente e não cabe segura os de trás. Só um leve (peso 1) passa na frente dele, e só enquanto ele esperou menos de 3 min; depois ninguém passa. `-Sozinho` nunca é passado.
- Dois pesados juntos: o que entra com outro pesado rodando recebe `CARGO_BUILD_JOBS=8` e `CMAKE_BUILD_PARALLEL_LEVEL=8` (só se a sessão não definiu). O primeiro, que entrou sozinho, fica sem limite.
- Sem `-Tipo`, o tipo vem do comando: cargo/cmake/ninja → Build, test/ctest/pytest → Teste, jogo-oculto/--hidden-window → Jogo.
- O código de saída do comando volta igual. A saída vai também para `logs\<id>.log`.
- Controles (o painel usa estes): `-Mover <id> topo|cima|baixo`, `-Cancelar <id>`, `-Pausar`, `-Soltar`, `-Limpar`.
- Respeita as vagas `lock`/`lock2` da versão antiga (de duas vagas) enquanto existirem: cada uma vale 2 pontos. A versão de pontos não cria pastas; os pontos em uso são as fichas rodando, e a decisão de entrar é tomada dentro da trava da fila. Um script antigo que já esperava na hora da troca não vê os pontos novos e pode entrar junto (só nessa transição): troque com a fila vazia.

Arquivos em `%LOCALAPPDATA%\fila-build` (ou `$env:FILA_BUILD_DIR`): `fichas\<id>.json`, `ordem.txt`, `pausa`, `logs\`, `historico.jsonl` e `sessoes\<sessão>.json` (do mod).

Teste: `pwsh -NoProfile -File plugin/fila/teste-fila.ps1` (usa uma pasta temporária, não mexe na fila de verdade; simula a máquina com `FILA_TESTE_MAQUINA=cpu,ramGB` e encurta os 3 min com `FILA_PASSAR_SEGUNDOS`).

## Painel

O painel abre sozinho no começo de toda sessão. Se for fechado, `/fila` abre de novo. Ele mostra:

- **Faixa de limites** (acima do cartão Rodando): o limite de 5 horas (`5h`) e o semanal (`7d`), cada um com barra ▰▱ e porcentagem (a barra muda de cor a partir de 80%). No plano sem limite de 5 horas a barra do `5h` fica cheia, com `∞`; sem leitura (sem assinatura, ou antes da primeira resposta da sessão) aparece `—`. À direita, o Acesso remoto da sessão que desenha o painel (⇄ ligado, desligado, conectando ou indisponível); clicar liga ou desliga (o app pode pedir aprovação ou recusar). O que mudar pela barra do app aparece em cerca de 10 s.
- **Rodando**: os pontos em uso de 4 no título; em cada item, tipo, nome, comando, há quanto tempo, o tempo estimado (média das últimas 5 do mesmo tipo e pasta), o peso quando passa de 1 e uma barra ▰▱. Botões 🗋 (log) e × (matar).
- **Na fila**: a posição, há quanto tempo espera e o comando, com os botões ↟ (topo), ↑, ↓ e × (cancelar).
- **Sessões ativas**: as sessões que estão trabalhando, esperando resposta sua ou com algo em segundo plano, em árvore (a sessão filha abaixo da mãe). Embaixo de cada uma, os subagentes (modelo e o que fazem) e os comandos de fundo fora da fila. O símbolo diz o estado: ● trabalhando, ? esperando você, ◌ só coisas de fundo. Clicar no nome de uma sessão do app desktop leva até ela (abre o link `claude://` dela; se ela ainda roda uma versão antiga do mod, é achada pelo título).
- **Pausar fila / Soltar fila**: enquanto pausada, nenhum pedido novo começa.

Cada seção é um cartão com a borda na cor dela, esmaecida quando está parada ou vazia, e o estado à direita do título. Cada item ocupa três linhas; no app desktop os botões são ícones e a descrição aparece ao passar o mouse (no terminal, a palavra).

Cada sessão avisa (`$.ui.notify`) quando pede permissão ou faz uma pergunta e quando termina o turno. No app desktop esse aviso do mod não tem onde aparecer; lá valem os banners do próprio app (Configurações, notificações de permissão, pergunta e tarefa concluída).

Quando algo da fila termina, aparece um aviso com o código de saída. O aviso sai na sessão dona do pedido e em toda sessão que estiver com o painel aberto (por padrão, todas).

Testes do mod: `claude plugin validate plugin` e `claude plugin test plugin`.

## Instalar e reinstalar

Do GitHub, numa sessão do Claude Code:

```
/plugin marketplace add maliquem/PainelFila
/plugin install painel-fila@painel-fila-local
```

A fila vem dentro do plugin (`plugin/fila/fila-build.ps1`) e é copiada à mão para `~/.claude/scripts/`, que é o caminho que as sessões e o painel chamam.

De uma cópia local:

```powershell
claude plugin marketplace add K:\src\PainelFila
```

```powershell
claude plugin install painel-fila@painel-fila-local --scope user
```

O mod é lido direto de `K:\src\PainelFila\plugin`. Depois de editar, rode `/reload-plugins` em cada sessão aberta. Sessões novas já carregam a versão nova.
