import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

const DADOS = 'C:\\dados\\fila-build'
const PANE = {
  plugin: 'painel-fila',
  component: 'Pane',
  requestId: 'fila',
  props: {
    title: 'Fila',
    isFocused: true,
    bodyColumns: 120,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const agora = Date.now()
const iso = (segAtras: number) => new Date(agora - segAtras * 1000).toISOString()
const ficha = (id: string, nome: string, estado: 'espera' | 'rodando', extra: object = {}) =>
  JSON.stringify({
    id,
    pid: 1,
    nome,
    sessao: 's1',
    tipo: 'Build',
    cmd: `cargo build -p ${nome}`,
    pasta: 'K:\\src\\Jogo',
    criado: iso(60),
    estado,
    comeco: estado === 'rodando' ? iso(30) : null,
    vagas: 1,
    seguras: [],
    log: `${DADOS}\\logs\\${id}.log`,
    ...extra,
  })

type Arquivos = Map<string, string>

// Um disco de mentira: os hooks abaixo respondem pelo engine.
function disco(on: On, arq: Arquivos, rodados: string[][]) {
  const pai = (p: string) => p.slice(0, p.lastIndexOf('\\'))
  on('env.get', (_, e) => ({ value: e.name === 'FILA_BUILD_DIR' ? DADOS : e.name === 'USERPROFILE' ? 'C:\\eu' : undefined }))
  on('fs.list', (_, e) => ({
    value: [...arq.keys()]
      .filter(p => pai(p) === e.path)
      .map(p => ({ name: p.slice(e.path.length + 1), kind: 'file' as const, size: arq.get(p)!.length, mtimeMs: 0, isLink: false })),
  }))
  on('fs.exists', (_, e) => ({ value: arq.has(e.path) }))
  on('fs.stat', (_, e) => {
    const t = arq.get(e.path)
    if (t === undefined) throw new Error('ENOENT')
    return { value: { kind: 'file' as const, size: t.length, mtimeMs: 0, isLink: false } }
  })
  on('fs.read', (_, e) => {
    const t = arq.get(e.path)
    if (t === undefined) throw new Error('ENOENT')
    const ini = e.offset ?? 0
    return { value: t.slice(ini, e.length === undefined ? undefined : ini + e.length) }
  })
  on('fs.write', (_, e) => {
    arq.set(e.path, e.text)
    return { value: undefined }
  })
  on('process.run', (_, e) => {
    rodados.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('process.hookEnv', () => ({ value: { CLAUDE_PID: '4242' } }))
  on('session.id', () => ({ value: 's1' }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
}

test('o painel mostra rodando, a fila na ordem do ordem.txt e as outras tarefas; ↑ move', async ($, on) => {
  const arq: Arquivos = new Map([
    [`${DADOS}\\fichas\\1-a.json`, ficha('1-a', 'alfa', 'rodando')],
    [`${DADOS}\\fichas\\2-b.json`, ficha('2-b', 'beta', 'espera')],
    [`${DADOS}\\fichas\\3-c.json`, ficha('3-c', 'gama', 'espera')],
    [`${DADOS}\\fichas\\3-c.cancelar`, ''],
    [`${DADOS}\\ordem.txt`, '3-c\r\n2-b\r\n'],
    [
      `${DADOS}\\historico.jsonl`,
      [100, 200]
        .map(s => JSON.stringify({ id: `h${s}`, nome: 'x', sessao: 's9', tipo: 'Build', cmd: 'cargo', pasta: 'k:\\src\\jogo', comeco: iso(900), fim: iso(800), segundos: s, codigo: 0, cancelado: false, log: '' }))
        .join('\n') + '\n',
    ],
    [
      `${DADOS}\\sessoes\\s2.json`,
      JSON.stringify({
        sessao: 's2',
        nome: 'Sessão Dois',
        pasta: 'K:\\src\\Outro',
        pid: 1,
        atualizado: agora,
        tarefas: [
          { id: 't1', type: 'subagent', status: 'running', description: 'procura código', agent_type: 'Explore', desde: agora - 5000 },
          { id: 't2', type: 'shell', status: 'running', description: 'fila', command: 'pwsh -File fila-build.ps1 -Nome x cargo build' },
          { id: 't3', type: 'shell', status: 'running', description: 'testes', command: 'pytest -q' },
        ],
      }),
    ],
    [`${DADOS}\\sessoes\\s3.json`, JSON.stringify({ sessao: 's3', nome: 'Fechada', pasta: '', pid: 1, atualizado: agora, encerrada: true, tarefas: [{ id: 'z', type: 'monitor', status: 'running', description: 'não deve aparecer' }] })],
  ])
  const rodados: string[][] = []
  disco(on, arq, rodados)
  on('command.register', () => ({ value: { command: 'fila' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: 'K:\\src', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'fila', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /1 rodando · 2 na fila/ }))?.text).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /Build\s+alfa/ }))?.text).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /^há 3\ds · est\. 2m30s$/ }))?.text).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /#1 / }))?.text).toMatch(/gama/)
    expect((await ui.find({ type: 'Text', text: /#2 / }))?.text).toMatch(/beta/)
    expect((await ui.find({ type: 'Text', text: /Subagente \(Explore\)/ }))?.text).toMatch(/Sessão Dois/)
    expect((await ui.find({ type: 'Text', text: /pytest/ }))?.text).toMatch(/^Teste/)
    expect(await ui.find({ type: 'Text', text: /fila-build/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /não deve aparecer/ })).toBeUndefined()
    await ui.unmount()
  }

  // Minimizado (widget): só o resumo e o que roda.
  const mini = await $.ui.mount({ ...PANE, props: { ...PANE.props, placement: 'widget' }, surface: 'desktop' })
  expect((await mini.find({ type: 'Text', text: /1 rodando · 2 na fila/ }))?.text).toBeDefined()
  expect((await mini.find({ type: 'Text', text: /alfa/ }))?.text).toMatch(/há 3\ds/)
  expect(await mini.find({ type: 'Text', text: /gama/ })).toBeUndefined()
  await mini.unmount()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'c-2-b' })
  await ui.press({ key: 'x-3-c' })
  await ui.press({ key: 'm-1-a' })
  await ui.press({ key: 'pausa' })
  expect(rodados.map(a => a.slice(4).join(' '))).toEqual(['-Mover 2-b cima', '-Cancelar 3-c', '-Cancelar 1-a', '-Pausar'])
  expect(rodados[0]?.slice(0, 4)).toEqual(['pwsh', '-NoProfile', '-File', 'C:\\eu\\.claude\\scripts\\fila-build.ps1'])

  // Log da ficha rodando: últimas linhas.
  arq.set(`${DADOS}\\logs\\1-a.log`, Array.from({ length: 30 }, (_, i) => `linha ${i + 1}`).join('\r\n') + '\r\n')
  await ui.press({ key: 'l-1-a' })
  expect(await ui.find({ type: 'Text', text: /^linha 10$/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /^linha 30$/ }))?.text).toBe('linha 30')
  expect((await ui.find({ type: 'Text', text: /^linha 11$/ }))?.text).toBe('linha 11')
  await ui.unmount()
})

test('Stop publica as tarefas ativas da sessão, com o nome da transcrição; session.end marca encerrada', async ($, on) => {
  const arq: Arquivos = new Map([
    ['C:\\t\\s1.jsonl', '{"type":"custom-title","customTitle":"Velho"}\n{"type":"custom-title","customTitle":"Fila \\"nova\\""}\n'],
  ])
  disco(on, arq, [])
  on('classic.Stop', () => ({}))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))

  await $.classic.Stop({
    session_id: 's1',
    transcript_path: 'C:\\t\\s1.jsonl',
    cwd: 'K:\\src\\Jogo',
    stop_hook_active: false,
    background_tasks: [
      { id: 'b1', type: 'shell', status: 'running', description: 'build', command: 'cargo build' },
      { id: 'b2', type: 'shell', status: 'completed', description: 'velha', command: 'ls' },
    ],
  })
  const s = JSON.parse(arq.get(`${DADOS}\\sessoes\\s1.json`)!)
  expect(s.nome).toBe('Fila "nova"')
  expect(s.pid).toBe(4242)
  expect(s.pasta).toBe('K:\\src\\Jogo')
  expect(s.tarefas.map((t: { id: string }) => t.id)).toEqual(['b1'])

  await $.session.end({ reason: 'other', sessionId: 's1', resume: { id: 's1' } })
  const fim = JSON.parse(arq.get(`${DADOS}\\sessoes\\s1.json`)!)
  expect(fim.encerrada).toBe(true)
  expect(fim.tarefas).toEqual([])
})

test('o painel abre sozinho no começo da sessão, inclusive no app desktop (SDK, isInteractive falso)', async ($, on) => {
  const abertos: string[] = []
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', (_, e) => {
    abertos.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('command.register', () => ({ value: { command: 'fila' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: 'K:\\src', surface: null, isInteractive: false })
  expect(abertos).toEqual(['fila'])
})
