// Painel /fila: mostra a fila do fila-build.ps1 e as sessões ativas, com subagentes e tarefas de fundo.
// Cada sessão publica o próprio estado em <pasta>\sessoes\<id>.json; o painel lê a pasta a cada 2 s.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Ficha, Foto, Hist, Sessao, Sub, Tarefa, Velha } from '../types'
import {
  arvoreDeSessoes,
  barra,
  curto,
  desde,
  dur,
  estimativa,
  fimMaisNovo,
  lerHistorico,
  nomeDoModelo,
  novosNoHistorico,
  ordenarFila,
  tarefasDaSessao,
  textoDoAviso,
  tipoDaTarefa,
  tituloDaTranscricao,
  ultimasLinhas,
} from './logica'

const PANE = 'fila'
const foto = atom({ plugin: 'painel-fila', key: 'foto' } as const, null, { shape: 'foto-1' })
const logDe = atom({ plugin: 'painel-fila', key: 'logDe' } as const, '')
const ultimoFim = atom({ plugin: 'painel-fila', key: 'ultimoFim' } as const, '')
const minhas = atom({ plugin: 'painel-fila', key: 'minhas' } as const, [])
const nomeSessao = atom({ plugin: 'painel-fila', key: 'nomeSessao' } as const, '')
const aviso = atom({ plugin: 'painel-fila', key: 'aviso' } as const, '')
const eu = atom({ plugin: 'painel-fila', key: 'eu' } as const, null)
const trabalhando = atom({ plugin: 'painel-fila', key: 'trabalhando' } as const, false)
const esperando = atom({ plugin: 'painel-fila', key: 'esperando' } as const, false)
const subagentes = atom({ plugin: 'painel-fila', key: 'subagentes' } as const, [])

type Api = EngineInterface

const juntar = (a: string, b: string) => `${a.replace(/[\\/]+$/, '')}\\${b}`

async function pastaDados($: Api): Promise<string> {
  const propria = await $.env.get('FILA_BUILD_DIR')
  if (propria) return propria
  return juntar((await $.env.get('LOCALAPPDATA')) ?? '', 'fila-build')
}

async function script($: Api): Promise<string> {
  return juntar((await $.env.get('USERPROFILE')) ?? '', '.claude\\scripts\\fila-build.ps1')
}

async function lerJson<T>($: Api, caminho: string): Promise<T | undefined> {
  try {
    return JSON.parse(await $.fs.read(caminho)) as T
  } catch {
    return undefined // sumiu ou está no meio da troca atômica: fica para a próxima volta
  }
}

async function lerFim($: Api, caminho: string, bytes: number): Promise<string> {
  try {
    const { size } = await $.fs.stat(caminho)
    const offset = Math.max(0, size - bytes)
    return await $.fs.read(caminho, { offset, length: size - offset })
  } catch {
    return ''
  }
}

async function listar($: Api, pasta: string, fim: string): Promise<string[]> {
  try {
    return (await $.fs.list(pasta)).filter(f => f.kind === 'file' && f.name.endsWith(fim)).map(f => juntar(pasta, f.name))
  } catch {
    return []
  }
}

async function lerHist($: Api, dados: string): Promise<Hist[]> {
  return lerHistorico(await lerFim($, juntar(dados, 'historico.jsonl'), 256 * 1024))
}

// Vagas seguradas pela versão antiga do script (dono.txt sem o 4º campo, o id).
async function lerVelhas($: Api, dados: string): Promise<Velha[]> {
  const velhas: Velha[] = []
  for (const vaga of ['lock', 'lock2', 'sozinho']) {
    let texto = ''
    try {
      texto = await $.fs.read(juntar(dados, `${vaga}\\dono.txt`))
    } catch {
      continue
    }
    const [, nome = '?', quando = '', id] = texto.trim().split('|')
    if (!id) velhas.push({ vaga, nome, desde: quando })
  }
  return velhas
}

async function montarFoto($: Api): Promise<Foto> {
  const dados = await pastaDados($)
  const fichas = (
    await Promise.all((await listar($, juntar(dados, 'fichas'), '.json')).map(c => lerJson<Ficha>($, c)))
  ).filter((f): f is Ficha => !!f && typeof f.id === 'string')
  const ordem = (await lerFim($, juntar(dados, 'ordem.txt'), 64 * 1024)).split(/\r?\n/).map(s => s.trim())
  const sessoes = (
    await Promise.all((await listar($, juntar(dados, 'sessoes'), '.json')).map(c => lerJson<Sessao>($, c)))
  ).filter((s): s is Sessao => !!s && !s.encerrada && Array.isArray(s.tarefas))
  const historico = await lerHist($, dados)
  const quem = await read($, logDe)
  let log: Foto['log']
  if (quem) {
    const f = fichas.find(x => x.id === quem) ?? historico.findLast(h => h.id === quem)
    if (f) {
      log = {
        id: quem,
        titulo: `${f.tipo} '${f.nome}' (${curto(f.cmd, 40)})`,
        linhas: ultimasLinhas(await lerFim($, f.log, 16 * 1024), 20),
      }
    }
  }
  return {
    agora: Date.now(),
    pausada: await $.fs.exists(juntar(dados, 'pausa')),
    rodando: fichas.filter(f => f.estado === 'rodando').sort((a, b) => (a.comeco ?? '').localeCompare(b.comeco ?? '')),
    fila: ordenarFila(fichas, ordem),
    velhas: await lerVelhas($, dados),
    sessoes: sessoes.sort((a, b) => a.nome.localeCompare(b.nome)),
    historico: historico.slice(-400),
    log,
  }
}

async function controlar($: Api, args: string[]): Promise<void> {
  try {
    const r = await $.process.run(['pwsh', '-NoProfile', '-File', await script($), ...args])
    await update($, aviso, () => (r.exitCode === 0 ? '' : `Não deu: ${(r.stdout + r.stderr).trim().split('\n').at(-1) ?? ''}`))
  } catch (erro) {
    await update($, aviso, () => `Não deu: ${String(erro)}`)
  }
  await atualizar($)
}

async function atualizar($: Api): Promise<void> {
  try {
    const f = await montarFoto($)
    await update($, foto, () => f)
  } catch (erro) {
    await update($, foto, v => (v ? { ...v, erro: String(erro) } : v))
  }
}

async function painelAberto($: Api): Promise<boolean> {
  // isPlaced: numa sessão sem tela (`claude -p`) o painel fica aberto mas não desenhado, e não deve gastar leituras.
  return (await $.ui.panes()).some(p => p.id === PANE && p.isPlaced)
}

// Avisa o que terminou desde a última volta: o que é desta sessão, ou tudo se o painel está aberto aqui.
async function avisar($: Api): Promise<void> {
  const hist = await lerHist($, await pastaDados($))
  // shortcut: dois fins no mesmo instante gravados fora de ordem podem perder um aviso; guardar ids vistos se acontecer.
  const fimMax = fimMaisNovo(hist) ?? ''
  const antes = await read($, ultimoFim)
  if (!antes) {
    await update($, ultimoFim, () => fimMax || new Date().toISOString())
    return
  }
  const novos = novosNoHistorico(hist, antes)
  if (novos.length === 0) return
  await update($, ultimoFim, () => fimMax)
  const eu = await $.session.id()
  const aberto = await painelAberto($)
  for (const h of novos) if (aberto || h.sessao === eu) $.ui.toast(textoDoAviso(h))
}

// As publicações vão uma de cada vez: duas em paralelo poderiam gravar a foto mais velha por último.
let publicando: Promise<unknown> = Promise.resolve()
function publicar($: Api, sessao: string, pasta: string, encerrada = false): Promise<void> {
  const vez = publicando.then(() => gravarSessao($, sessao, pasta, encerrada))
  publicando = vez.catch(() => undefined)
  return vez
}

async function gravarSessao($: Api, sessao: string, pasta: string, encerrada: boolean): Promise<void> {
  const env = await $.process.hookEnv()
  const quem = await read($, eu)
  // Subagente cujo fim o mod não ouviu (recarregado no meio) sai quando o engine já não o tem rodando.
  const vivos = await $.agent
    .list()
    .then(l => new Set(l.filter(a => a.taskStatus === 'running' || a.taskStatus === 'pending').map(a => a.id)))
    .catch(() => undefined)
  if (vivos) await update($, subagentes, l => (l.every(a => vivos.has(a.id)) ? l : l.filter(a => vivos.has(a.id))))
  const dados: Sessao = {
    sessao,
    nome: quem?.titulo || (await read($, nomeSessao)) || pasta.split(/[\\/]/).filter(Boolean).at(-1) || sessao,
    pasta,
    pid: Number(env.CLAUDE_PID ?? 0),
    atualizado: Date.now(),
    encerrada: encerrada || undefined,
    tarefas: encerrada ? [] : await read($, minhas),
    ccd: quem?.ccd || undefined,
    ccdPai: quem?.ccdPai,
    modelo: quem?.modelo || undefined,
    esforco: quem?.esforco,
    trabalhando: !encerrada && (await read($, trabalhando)),
    esperando: !encerrada && (await read($, esperando)),
    subagentes: encerrada ? [] : await read($, subagentes),
  }
  await $.fs.write(juntar(juntar(await pastaDados($), 'sessoes'), `${sessao}.json`), JSON.stringify(dados))
}

async function publicarAqui($: Api): Promise<void> {
  await publicar($, await $.session.id(), await $.session.cwd()).catch(() => undefined)
}

// Quem é esta sessão no app desktop: id local_…, mãe, título, modelo e esforço. Fora do app (sem
// ccd_session_mgmt) fica só o modelo da própria sessão. Devolve true se algo mudou.
async function quemSouEu($: Api): Promise<boolean> {
  const antes = await read($, eu)
  let novo = antes
  try {
    const r = await $.mcp.call('ccd_session_mgmt', 'get_session', { session_id: 'self' })
    const bloco = r.content.find(c => c.type === 'text') as { text?: string } | undefined
    const j = JSON.parse(bloco?.text ?? '') as {
      sessionId?: string
      parentSessionId?: string
      detached?: boolean
      title?: string
      model?: string
      effort?: string
    }
    if (r.isError || !j.sessionId) throw new Error('sem sessionId')
    novo = {
      ccd: j.sessionId,
      ccdPai: j.detached ? undefined : j.parentSessionId,
      titulo: j.title ?? '',
      modelo: j.model ?? '',
      esforco: j.effort,
    }
  } catch {
    const modelo = await $.session.model().catch(() => '')
    novo = { ccd: antes?.ccd ?? '', ccdPai: antes?.ccdPai, titulo: antes?.titulo ?? '', modelo, esforco: antes?.esforco }
  }
  if (JSON.stringify(novo) === JSON.stringify(antes)) return false
  await update($, eu, () => novo)
  return true
}

// Notificação nativa só desta sessão (cada sessão avisa por si, sem repetir entre elas).
async function notificar($: Api, texto: string, chave: string): Promise<void> {
  const titulo = (await read($, eu))?.titulo || (await read($, nomeSessao)) || 'Claude'
  await $.ui.notify(texto, { title: titulo, key: `${chave}-${await $.session.id()}` }).catch(() => undefined)
}

// Pedido de permissão ou pergunta: a sessão fica "esperando" e avisa. Os sinais do mesmo pedido
// (PermissionRequest e Notification) chegam juntos: avisa uma vez só.
let ultimoPedido = 0
let pediuEm = 0
async function precisaDela($: Api, texto: string): Promise<void> {
  pediuEm = Date.now()
  await update($, esperando, () => true)
  await publicarAqui($)
  if (Date.now() - ultimoPedido < 5000) return
  ultimoPedido = Date.now()
  await notificar($, texto, 'pedido')
}

async function aoParar(
$: Api,
e: { session_id: string; cwd: string; transcript_path: string; background_tasks?: readonly Tarefa[] },
): Promise<void> {
  const antigas = new Map((await read($, minhas)).map(t => [t.id, t.desde]))
  const agora = Date.now()
  const tarefas = (e.background_tasks ?? [])
    .filter(t => ATIVAS.test(t.status))
    .map(t => ({
      id: t.id,
      type: t.type,
      status: t.status,
      description: t.description,
      command: t.command,
      agent_type: t.agent_type,
      desde: antigas.get(t.id) ?? agora,
    }))
  await update($, minhas, () => tarefas)
  const titulo = tituloDaTranscricao(await lerFim($, e.transcript_path, 512 * 1024))
  if (titulo) await update($, nomeSessao, () => titulo)
  await publicar($, e.session_id, e.cwd)
}

// Abre a sessão no app desktop pelo link claude:// dele (o Link do mod só abre https no desktop).
// shortcut: formato do campo `link` de list_sessions; se o app mudar o endereço, atualizar aqui.
const ID_DO_APP = /^local_[\w-]+$/
// Sessão que ainda roda uma versão antiga do mod não publica o id: acha pelo título (a pasta desempata).
async function idPeloTitulo($: Api, s: Sessao): Promise<string | undefined> {
  const r = await $.mcp.call('ccd_session_mgmt', 'list_sessions', { limit: 100 })
  const bloco = r.content.find(c => c.type === 'text') as { text?: string } | undefined
  const lista = JSON.parse(bloco?.text ?? '') as { sessionId: string; title?: string; cwd?: string }[]
  let iguais = lista.filter(x => x.title === s.nome)
  if (iguais.length > 1) iguais = iguais.filter(x => x.cwd?.toLowerCase() === s.pasta.toLowerCase())
  return iguais.length === 1 ? iguais[0]?.sessionId : undefined
}

async function irPara($: Api, s: Sessao): Promise<void> {
  try {
    const ccd = s.ccd || (await idPeloTitulo($, s))
    if (!ccd || !ID_DO_APP.test(ccd)) {
      await update($, aviso, () => `Não achei '${s.nome}' no app. Rode /reload-plugins nela.`)
      return
    }
    const r = await $.process.run(['rundll32.exe', 'url.dll,FileProtocolHandler', `claude://claude.ai/epitaxy/${ccd}`])
    await update($, aviso, () => (r.exitCode === 0 ? '' : `Não deu para abrir a sessão (código ${r.exitCode})`))
  } catch (erro) {
    await update($, aviso, () => `Não deu: ${String(erro)}`)
  }
}

// Uma cor por tipo, das cores do tema, para achar o item de olho.
type Cor = 'suggestion' | 'success' | 'claude' | 'warning' | 'merged'
function corDoTipo(tipo: string): Cor | undefined {
  if (tipo === 'Build') return 'suggestion'
  if (tipo === 'Teste') return 'success'
  if (tipo === 'Jogo') return 'claude'
  if (tipo === 'Medição') return 'warning'
  if (tipo.startsWith('Subagente')) return 'merged'
  return undefined
}

const ATIVAS = /^(running|pending|in_progress|starting|working)$/i

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'fila', description: 'Abre o painel da fila de builds e das tarefas de fundo' })
    let volta = 0
    let tique = 0
    $.clock.every(2000, () => {
      void (async () => {
        // Logo no começo e a cada ~1 min confere título, modelo e mãe; publica se mudou.
        if (tique++ % 30 === 0 && (await quemSouEu($).catch(() => false))) await publicarAqui($)
        await avisar($).catch(() => undefined)
        if (!(await painelAberto($).catch(() => false))) return
        await atualizar($)
        // a cada ~30 s limpa fichas e sessões de donos mortos; a marca 'limpeza' faz só uma sessão rodar por vez
        if (++volta % 15 === 0) {
          const marca = juntar(await pastaDados($), 'limpeza')
          const ultima = await $.fs.stat(marca).then(s => s.mtimeMs).catch(() => 0)
          if (Date.now() - ultima < 25000) return
          await $.fs.write(marca, '').catch(() => undefined)
          await $.process.run(['pwsh', '-NoProfile', '-File', await script($), '-Limpar']).catch(() => undefined)
        }
      })()
    })
    // Abre sozinho em toda sessão. Sem checar isInteractive: o app desktop abre as sessões pelo SDK, onde ele vem falso.
    // Sem tela (`claude -p`), o painel espera sem ser desenhado.
    await $.ui.open({ id: PANE, title: 'Fila' }).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'fila' }, async $ => {
    await atualizar($)
    await $.ui.open({ id: PANE, title: 'Fila' })
    return { text: 'Painel da fila aberto.' }
  })

  on('classic.Stop', async ($, e, next) => {
    await aoParar($, e).catch(() => undefined)
    const ultima = curto(e.last_assistant_message ?? '', 120)
    await notificar($, ultima ? `Terminou: ${ultima}` : 'Terminou o turno', 'fim')
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined && !(await read($, trabalhando))) {
      await update($, trabalhando, () => true)
      await publicarAqui($)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, trabalhando, () => false)
      await update($, esperando, () => false)
    } else {
      await update($, subagentes, l => l.filter(a => a.id !== e.agentId))
    }
    await publicarAqui($)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (r.agentId) {
      const a: Sub = {
        id: r.agentId,
        modelo: r.model || e.model || e.parentModel,
        descricao: e.description,
        tipo: e.subagentType,
        desde: Date.now(),
      }
      await update($, subagentes, l => [...l.filter(x => x.id !== a.id), a])
      await publicarAqui($)
    }
    return r
  }).catch(($, e, next) => next(e))

  on('classic.PermissionRequest', async ($, e, next) => {
    await precisaDela($, `Pede permissão: ${e.tool_name}`).catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.Notification', async ($, e, next) => {
    // idle_prompt repete o aviso do fim do turno; plugin_notification é o aviso de um mod.
    if (/permission|elicitation/i.test(e.notification_type)) await precisaDela($, e.message).catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.SubagentStop', async ($, e, next) => {
    await aoParar($, e).catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  // Comando, subagente ou monitor que vai para o fundo aparece já, sem esperar o fim do turno.
  on('tool.call', async ($, e, next) => {
    const inicio = Date.now()
    if (e.tool === 'AskUserQuestion') await precisaDela($, 'Tem uma pergunta para você').catch(() => undefined)
    const ran = await next(e)
    // Só a chamada que esperou pelo pedido o responde: a de um subagente que termina no meio não.
    if (pediuEm >= inicio && (await read($, esperando))) {
      await update($, esperando, () => false)
      await publicarAqui($)
    }
    const r = ran.result as { backgroundTaskId?: string; taskId?: string } | undefined
    const id = r?.backgroundTaskId ?? (e.tool === 'Monitor' ? r?.taskId : undefined)
    if (id) {
      const ent = e as { command?: string; description?: string }
      const t: Tarefa = {
        id,
        type: e.tool === 'Monitor' ? 'monitor' : 'shell',
        status: 'running',
        description: ent.description ?? '',
        command: ent.command,
        desde: Date.now(),
      }
      await update($, minhas, l => [...l.filter(x => x.id !== id), t])
      await publicarAqui($)
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    await publicar($, e.sessionId, '', true).catch(() => undefined)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const f = await read($, foto)
    const msg = await read($, aviso)
    if (!f) return <Text dimColor>Lendo a fila…</Text>
    // No terminal não há mouse: os botões mostram a palavra em vez do ícone com dica.
    const terminal = e.surface === 'terminal'

    const verLog = (id: string) => update($, logDe, v => (v === id ? '' : id)).then(() => atualizar($))
    const nRodando = f.rodando.length + f.velhas.length
    const resumo = `${nRodando} rodando · ${f.fila.length} na fila${f.pausada ? ' · pausada' : ''}`

    // Minimizado no app desktop: só o resumo e o que roda agora.
    if (e.props.placement === 'widget') {
      const r = f.rodando[0]
      return (
        <Box flexDirection="column">
          <Text bold color={f.pausada ? 'warning' : undefined}>{resumo}</Text>
          {r && (
            <Text>
              <Text color={corDoTipo(r.tipo)}>{r.tipo}</Text> {r.nome} <Text dimColor>há {dur(desde(r.comeco, f.agora))}</Text>
            </Text>
          )}
        </Box>
      )
    }

    // A descrição aparece ao passar o mouse: um Box com key é o escopo do hover, e o cartão escondido
    // (absolute, fora do fluxo) aparece por cima sem mexer no resto.
    const dica = (key: string, texto: string, alvo: RenderChildren, lado: 'left' | 'right' = 'right') => (
      <Box key={key} flexShrink={lado === 'right' ? 0 : 1} minWidth={lado === 'right' ? 3 : 0} justifyContent="center">
        {alvo}
        <Box position="absolute" top={1} {...{ [lado]: 0 }} display="none" hover={{ display: 'flex' }} backgroundColor="text" paddingX={1}>
          <Text color="inverseText" wrap="truncate-end">{texto}</Text>
        </Box>
      </Box>
    )
    // Ícones em texto: Button só aceita texto dentro (não um Svg). Todos em traço, sem versão emoji colorida.
    const botao = (key: string, icone: string, texto: string, acao: () => unknown) =>
      terminal ? (
        <Button key={key} plain onPress={acao}>{texto}</Button>
      ) : (
        dica(`d${key}`, texto, <Button key={key} plain onPress={acao}>{icone}</Button>)
      )

    // Um cartão por seção: borda e título na cor dela, borda esmaecida quando parada ou vazia.
    const secao = (key: string, titulo: string, cor: Cor, ativa: boolean, estado: string, corpo: RenderChildren) => (
      <Box key={key} flexDirection="column" borderStyle="round" borderColor={cor} borderDimColor={!ativa} paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between" gap={1}>
          <Text bold color={cor} wrap="truncate-end">{titulo}</Text>
          <Box flexShrink={0}>
            <Text color={cor} dimColor={!ativa}>{estado}</Text>
          </Box>
        </Box>
        <Box flexDirection="column" gap={1}>{corpo}</Box>
      </Box>
    )
    // Coluna de largura fixa, para as linhas ficarem alinhadas.
    const coluna = (largura: number, conteudo?: RenderChildren) => (
      <Box width={largura} flexShrink={0}>{conteudo}</Box>
    )
    // O resto da linha: ocupa o que sobra e é cortado.
    const resto = (...conteudo: RenderChildren[]) => (
      <Box flexDirection="row" gap={1} flexGrow={1} flexShrink={1} overflow="hidden">{conteudo}</Box>
    )
    const tempos = (inicio: string, segundos: number, prev: number | undefined, fim = '') => (
      <Text wrap="truncate-end">
        <Text dimColor>{inicio}</Text>
        <Text bold>{dur(segundos)}</Text>
        {prev !== undefined && <Text dimColor> · est. </Text>}
        {prev !== undefined && <Text bold>{dur(prev)}</Text>}
        <Text dimColor>{fim}</Text>
      </Text>
    )
    // Item de 3 linhas: marca, tipo e nome; rótulo, barra e tempos; comando e botões.
    const item = (
      key: string,
      marca: string,
      cor: Cor,
      tipo: string,
      nome: string,
      rotulo: string,
      tempo: RenderChildren[],
      cmd: string,
      botoes: RenderChildren[],
    ) => (
      <Box key={key} flexDirection="column">
        <Box flexDirection="row" gap={1}>
          {coluna(3, <Text color={cor}>{marca}</Text>)}
          {coluna(8, <Text bold color={corDoTipo(tipo)} wrap="truncate-end">{tipo}</Text>)}
          {resto(<Text bold wrap="truncate-end">{nome}</Text>)}
        </Box>
        <Box flexDirection="row" gap={1}>
          {coluna(3)}
          {coluna(8, <Text dimColor>{rotulo}</Text>)}
          {resto(...tempo)}
        </Box>
        <Box flexDirection="row" gap={1}>
          {coluna(3)}
          {resto(<Text dimColor wrap="truncate-end">{curto(cmd, 200)}</Text>)}
          <Box key={`bt-${key}`} flexDirection="row" gap={1} flexShrink={0} flexWrap="nowrap">
            {botoes}
          </Box>
        </Box>
      </Box>
    )

    // Estado da sessão em um símbolo, com a descrição no hover (no terminal, a palavra ao lado).
    const estado = (s: Sessao) => {
      const [sim, cor, texto] = s.esperando
        ? (['?', 'warning', 'Esperando resposta sua'] as const)
        : s.trabalhando
          ? (['●', 'success', 'Trabalhando'] as const)
          : (['◌', 'suggestion', 'Só tarefas de fundo ou subagentes'] as const)
      return terminal ? (
        <Text color={cor}>{sim} {texto.toLowerCase()}</Text>
      ) : (
        dica(`e-${s.sessao}`, texto, <Text color={cor}>{sim}</Text>)
      )
    }
    // Clicar no nome abre a sessão no app.
    const nomeDaSessao = (s: Sessao) => {
      const nome = <Text bold wrap="truncate-end">{s.nome}</Text>
      const link = <Button key={`ir-${s.sessao}`} plain onPress={() => irPara($, s)}>{nome}</Button>
      return terminal ? link : dica(`dir-${s.sessao}`, 'Ir para a sessão', link, 'left')
    }
    // Linha debaixo da sessão: subagente ou tarefa de fundo.
    const filha = (key: string, rotulo: string, cor: Cor | undefined, descricao: string, direita: string) => (
      <Box key={key} flexDirection="row" gap={1} paddingLeft={1}>
        {coluna(1, <Text dimColor>⌞</Text>)}
        {coluna(11, <Text bold color={cor} wrap="truncate-end">{rotulo}</Text>)}
        {resto(<Text wrap="truncate-end">{descricao}</Text>)}
        <Box flexShrink={0}>
          <Text dimColor>{direita}</Text>
        </Box>
      </Box>
    )
    const arvore = arvoreDeSessoes(f.sessoes)

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
          <Text bold color={f.pausada ? 'warning' : undefined} wrap="truncate-end">{resumo}</Text>
          <Button key="pausa" variant={f.pausada ? 'primary' : 'secondary'} onPress={() => controlar($, [f.pausada ? '-Soltar' : '-Pausar'])}>
            {f.pausada ? 'Soltar fila' : 'Pausar fila'}
          </Button>
        </Box>
        {f.pausada && <Text color="warning">Fila pausada: nada novo começa até soltar.</Text>}
        {msg !== '' && <Text color="error">{msg}</Text>}
        {f.erro && <Text color="error">Erro ao ler a pasta: {f.erro}</Text>}

        {secao('sec-rodando', 'Rodando', 'claude', nRodando > 0, nRodando > 0 ? `● ${nRodando} rodando` : '○ parada', [
          ...f.rodando.map(r => {
            const passou = desde(r.comeco, f.agora)
            const prev = estimativa(f.historico, r.tipo, r.pasta)
            return item(
              `r-${r.id}`,
              '●',
              'claude',
              r.tipo,
              r.nome,
              'tempo',
              [
                prev !== undefined && (
                  <Box flexShrink={0}>
                    <Text color={corDoTipo(r.tipo)}>{barra(Math.min(passou, prev), prev)}</Text>
                  </Box>
                ),
                tempos('há ', passou, prev, r.vagas > 1 ? ' · 2 vagas' : ''),
              ],
              r.cmd,
              [
                botao(`l-${r.id}`, '🗋', 'Log', () => verLog(r.id)),
                botao(`m-${r.id}`, '×', 'Matar', () => controlar($, ['-Cancelar', r.id])),
              ],
            )
          }),
          ...f.velhas.map(v => (
            <Text dimColor wrap="truncate-end">
              {v.vaga} · {v.nome} · versão antiga do script{v.desde ? ` · desde ${v.desde}` : ''}
            </Text>
          )),
        ])}

        {secao(
          'sec-fila',
          'Na fila',
          'suggestion',
          f.fila.length > 0 && !f.pausada,
          f.pausada ? ['pausada', f.fila.length].filter(Boolean).join(' · ') : f.fila.length > 0 ? `${f.fila.length} na fila` : '○ vazia',
          f.fila.map((q, i) =>
            item(
              `q-${q.id}`,
              `#${i + 1}`,
              'suggestion',
              q.tipo,
              q.nome,
              'espera',
              [tempos('', desde(q.criado, f.agora), estimativa(f.historico, q.tipo, q.pasta))],
              q.cmd,
              [
                botao(`t-${q.id}`, '↟', 'Topo', () => controlar($, ['-Mover', q.id, 'topo'])),
                botao(`c-${q.id}`, '↑', 'Subir', () => controlar($, ['-Mover', q.id, 'cima'])),
                botao(`b-${q.id}`, '↓', 'Descer', () => controlar($, ['-Mover', q.id, 'baixo'])),
                botao(`x-${q.id}`, '×', 'Cancelar', () => controlar($, ['-Cancelar', q.id])),
              ],
            ),
          ),
        )}

        {secao(
          'sec-sessoes',
          'Sessões ativas',
          'merged',
          arvore.length > 0,
          arvore.length > 0 ? `${arvore.length} ativa${arvore.length > 1 ? 's' : ''}` : '○ nenhuma',
          arvore.map(({ s, nivel }) => {
            const modelo = nomeDoModelo(s.modelo, s.esforco)
            return (
              <Box key={`s-${s.sessao}`} flexDirection="column" paddingLeft={nivel * 2}>
                <Box flexDirection="row" justifyContent="space-between" gap={1}>
                  <Box flexDirection="row" gap={1} flexShrink={1} minWidth={0}>
                    {nivel > 0 && <Text dimColor>•</Text>}
                    {nomeDaSessao(s)}
                    {modelo !== '' && <Text color="merged" wrap="truncate-end">({modelo})</Text>}
                    {s.ccdPai && <Text dimColor wrap="truncate-end">(Sessão filha)</Text>}
                  </Box>
                  {estado(s)}
                </Box>
                {(s.subagentes ?? []).map(a => {
                  // Sem modelo conhecido, o tipo (que não cabe na coluna) abre a descrição.
                  const m = nomeDoModelo(a.modelo)
                  const descricao = m ? `(${a.descricao})` : `${a.tipo} (${a.descricao})`
                  return filha(`a-${s.sessao}-${a.id}`, m || 'Agente', 'merged', descricao, '[Subagente]')
                })}
                {tarefasDaSessao(s).map(t => {
                  // "Subagente (Explore)": o tipo fica na coluna e o resto abre a descrição.
                  const [tipo = '', ...extra] = tipoDaTarefa(t).split(' ')
                  return filha(
                    `o-${s.sessao}-${t.id}`,
                    tipo,
                    corDoTipo(tipo),
                    [...extra, curto(t.command ?? t.description, 200)].join(' '),
                    t.desde === undefined ? '' : `há ${dur((f.agora - t.desde) / 1000)}`,
                  )
                })}
              </Box>
            )
          }),
        )}

        {f.log && (
          <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1}>
            <Box flexDirection="row" justifyContent="space-between" gap={1}>
              <Text bold wrap="truncate-end">Log: {f.log.titulo}</Text>
              {botao('fechar-log', '×', 'Fechar log', () => verLog(f.log?.id ?? ''))}
            </Box>
            {f.log.linhas.length === 0 && <Text dimColor>(vazio)</Text>}
            {f.log.linhas.map(l => (
              <Text dimColor>{l}</Text>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
