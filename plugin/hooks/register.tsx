// Painel /fila: mostra a fila do fila-build.ps1 e as tarefas de fundo de todas as sessões.
// Cada sessão publica as próprias tarefas em <pasta>\sessoes\<id>.json; o painel lê a pasta a cada 2 s.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Ficha, Foto, Hist, Sessao, Tarefa, Velha } from '../types'
import {
  curto,
  desde,
  dur,
  ehDaFila,
  estimativa,
  fimMaisNovo,
  lerHistorico,
  novosNoHistorico,
  ordenarFila,
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
  return (await $.ui.panes()).some(p => p.id === PANE)
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

async function publicar($: Api, sessao: string, pasta: string, encerrada = false): Promise<void> {
  const env = await $.process.hookEnv()
  const dados: Sessao = {
    sessao,
    nome: (await read($, nomeSessao)) || pasta.split(/[\\/]/).filter(Boolean).at(-1) || sessao,
    pasta,
    pid: Number(env.CLAUDE_PID ?? 0),
    atualizado: Date.now(),
    encerrada: encerrada || undefined,
    tarefas: encerrada ? [] : await read($, minhas),
  }
  await $.fs.write(juntar(juntar(await pastaDados($), 'sessoes'), `${sessao}.json`), JSON.stringify(dados))
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

const ATIVAS = /^(running|pending|in_progress|starting|working)$/i

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'fila', description: 'Abre o painel da fila de builds e das tarefas de fundo' })
    let volta = 0
    $.clock.every(2000, () => {
      void (async () => {
        await avisar($).catch(() => undefined)
        if (!(await painelAberto($).catch(() => false))) return
        await atualizar($)
        // a cada ~30 s, com o painel aberto, limpa fichas e sessões de donos mortos
        if (++volta % 15 === 0) {
          await $.process.run(['pwsh', '-NoProfile', '-File', await script($), '-Limpar']).catch(() => undefined)
        }
      })()
    })
    return next(e)
  })

  on('command.run', { command: 'fila' }, async $ => {
    await atualizar($)
    await $.ui.open({ id: PANE, title: 'Fila' })
    return { text: 'Painel da fila aberto.' }
  })

  on('classic.Stop', async ($, e, next) => {
    await aoParar($, e).catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.SubagentStop', async ($, e, next) => {
    await aoParar($, e).catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  // Comando, subagente ou monitor que vai para o fundo aparece já, sem esperar o fim do turno.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
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
      await publicar($, await $.session.id(), await $.session.cwd()).catch(() => undefined)
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
    const largura = Math.max(30, (e.props.bodyColumns ?? 80) - 30)
    if (!f) return <Text dimColor>Lendo a fila…</Text>

    const est = (tipo: string, pasta: string) => {
      const s = estimativa(f.historico, tipo, pasta)
      return s === undefined ? '' : ` · est. ${dur(s)}`
    }
    const outras = f.sessoes.flatMap(s =>
      s.tarefas.filter(t => !ehDaFila(t)).map(t => ({ s, t })),
    )
    const verLog = (id: string) => update($, logDe, v => (v === id ? '' : id)).then(() => atualizar($))

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Text bold>
            {f.rodando.length + f.velhas.length} rodando · {f.fila.length} na fila
            {f.pausada ? ' · PAUSADA' : ''}
          </Text>
          <Button key="pausa" variant={f.pausada ? 'primary' : 'secondary'} onPress={() => controlar($, [f.pausada ? '-Soltar' : '-Pausar'])}>
            {f.pausada ? 'Soltar fila' : 'Pausar fila'}
          </Button>
        </Box>
        {f.pausada && <Text color="yellow">Fila pausada: nada novo começa até soltar.</Text>}
        {msg !== '' && <Text color="red">{msg}</Text>}
        {f.erro && <Text color="red">Erro ao ler a pasta: {f.erro}</Text>}

        <Box flexDirection="column">
          <Text bold>Rodando</Text>
          {f.rodando.length + f.velhas.length === 0 && <Text dimColor>nada</Text>}
          {f.rodando.map(r => (
            <Box key={`r-${r.id}`} flexDirection="row" gap={1} flexWrap="wrap">
              <Text>
                <Text bold>{r.tipo}</Text> · {r.nome} · {curto(r.cmd, largura)} · há {dur(desde(r.comeco, f.agora))}
                {est(r.tipo, r.pasta)}
                {r.vagas > 1 ? ' · 2 vagas' : ''}
              </Text>
              <Button key={`m-${r.id}`} onPress={() => controlar($, ['-Cancelar', r.id])}>Matar</Button>
              <Button key={`l-${r.id}`} onPress={() => verLog(r.id)}>Log</Button>
            </Box>
          ))}
          {f.velhas.map(v => (
            <Text dimColor>
              {v.vaga} · {v.nome} · versão antiga do script{v.desde ? ` · desde ${v.desde}` : ''}
            </Text>
          ))}
        </Box>

        <Box flexDirection="column">
          <Text bold>Na fila</Text>
          {f.fila.length === 0 && <Text dimColor>vazia</Text>}
          {f.fila.map((q, i) => (
            <Box key={`q-${q.id}`} flexDirection="row" gap={1} flexWrap="wrap">
              <Text>
                #{i + 1} <Text bold>{q.tipo}</Text> · {q.nome} · {curto(q.cmd, largura)} · espera há{' '}
                {dur(desde(q.criado, f.agora))}
                {est(q.tipo, q.pasta)}
              </Text>
              <Button key={`c-${q.id}`} onPress={() => controlar($, ['-Mover', q.id, 'cima'])}>↑</Button>
              <Button key={`b-${q.id}`} onPress={() => controlar($, ['-Mover', q.id, 'baixo'])}>↓</Button>
              <Button key={`t-${q.id}`} onPress={() => controlar($, ['-Mover', q.id, 'topo'])}>Topo</Button>
              <Button key={`x-${q.id}`} onPress={() => controlar($, ['-Cancelar', q.id])}>Cancelar</Button>
            </Box>
          ))}
        </Box>

        <Box flexDirection="column">
          <Text bold>Outras tarefas de fundo</Text>
          {outras.length === 0 && <Text dimColor>nenhuma</Text>}
          {outras.map(({ s, t }) => (
            <Text>
              <Text bold>{tipoDaTarefa(t)}</Text> · {s.nome} · {curto(t.command ?? t.description, largura)}
              {t.desde ? ` · há ${dur((f.agora - t.desde) / 1000)}` : ''}
            </Text>
          ))}
        </Box>

        {f.log && (
          <Box flexDirection="column">
            <Box flexDirection="row" gap={1}>
              <Text bold>Log: {f.log.titulo}</Text>
              <Button key="fechar-log" onPress={() => verLog(f.log?.id ?? '')}>Fechar log</Button>
            </Box>
            {f.log.linhas.length === 0 && <Text dimColor>(vazio)</Text>}
            {f.log.linhas.map((l, i) => (
              <Text dimColor>
                {l}
              </Text>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
