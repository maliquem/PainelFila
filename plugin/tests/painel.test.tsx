import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

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

// Todo o texto que um elemento mostra, descendo pelos filhos.
function texto(el: unknown): string {
  if (typeof el === 'string') return el
  const e = el as { type?: string; children?: unknown[] } | undefined
  // Dentro de um Text os pedaços vão colados; entre elementos, um espaço.
  return (e?.children ?? []).map(texto).join(e?.type === 'Text' ? '' : ' ')
}

const filhosBox = (el: { children: unknown[] } | undefined) =>
  (el?.children ?? []).filter(x => (x as { type?: string }).type === 'Box')

test('o painel mostra rodando, a fila na ordem do ordem.txt e as sessões ativas; botões em ícone com dica', async ($, on) => {
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
  const naLista: object[] = []
  on('mcp.call', (_, e) => ({
    value: { content: [{ type: 'text' as const, text: JSON.stringify(e.tool === 'list_sessions' ? naLista : {}) }], isError: false },
  }))
  on('command.register', () => ({ value: { command: 'fila' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: 'K:\\src', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'fila', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })

  for (const surface of ['desktop', 'terminal'] as const) {
    // Painel estreito, como no app desktop.
    const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 40 }, surface })
    expect((await ui.find({ type: 'Text', text: /1 rodando · 2 na fila/ }))?.text).toBeDefined()
    const rodando = texto(await ui.find({ key: 'r-1-a' }))
    expect(rodando).toMatch(/Build alfa/)
    // ±1 s: o relógio anda entre montar a ficha e desenhar.
    expect(rodando).toMatch(/▰+▱+ há (29|30|31|32)s · est\. 2m30s/)
    expect(rodando).toMatch(/cargo build -p alfa/)
    // Um cartão por seção, com a borda na cor dela e o estado no cabeçalho.
    for (const [key, borderColor, estado] of [
      ['sec-rodando', 'claude', /^Rodando ● 1 rodando/],
      ['sec-fila', 'suggestion', /^Na fila 2 na fila/],
      ['sec-sessoes', 'merged', /^Sessões ativas 1 ativa /],
    ] as const) {
      const sec = await ui.find({ key })
      expect(sec?.props).toMatchObject({ borderStyle: 'round', borderColor, borderDimColor: false, paddingX: 1 })
      expect(texto(sec)).toMatch(estado)
    }
    // Cada item tem três linhas: nome, tempos e comando com os botões.
    const cartoes = (await ui.findAll({ type: 'Box' })).filter(b => /^[rq]-/.test(b.key ?? ''))
    expect(cartoes.map(b => b.key)).toEqual(['r-1-a', 'q-3-c', 'q-2-b'])
    for (const c of cartoes) expect(filhosBox(c)).toHaveLength(3)
    expect(texto(cartoes[1])).toMatch(/^#1 Build gama/)
    expect(texto(cartoes[2])).toMatch(/^#2 Build beta/)
    for (const b of await ui.findAll({ type: 'Button' })) if (b.key !== 'pausa') expect(b.props.plain).toBe(true)
    const rotulos = (ks: string[]) => Promise.all(ks.map(async k => (await ui.find({ key: k }))?.text))
    // Os botões ficam lado a lado (um Fragment os empilharia numa coluna), com o ↟ primeiro.
    const fileira = await ui.find({ key: 'bt-q-3-c' })
    expect(fileira?.props.flexDirection).toBe('row')
    expect((fileira?.children as { props: { key?: string } }[]).map(b => b.props.key)).toEqual(
      ['t-3-c', 'c-3-c', 'b-3-c', 'x-3-c'].map(k => (surface === 'desktop' ? `d${k}` : k)),
    )
    if (surface === 'desktop') {
      expect(await rotulos(['l-1-a', 'm-1-a', 't-3-c', 'c-3-c', 'b-3-c', 'x-3-c'])).toEqual(['🗋', '×', '↟', '↑', '↓', '×'])
      // A descrição fica escondida e aparece no hover.
      const escondida = filhosBox(await ui.find({ key: 'dx-3-c' }))[0] as { props: Record<string, unknown> }
      // O kit de teste não devolve o hover nas props: confere só que a dica nasce escondida e fora do fluxo.
      expect(escondida.props).toMatchObject({ display: 'none', position: 'absolute' })
      expect(texto(escondida)).toBe('Cancelar')
    } else {
      expect(await rotulos(['l-1-a', 'm-1-a', 't-3-c', 'x-3-c'])).toEqual(['Log', 'Matar', 'Topo', 'Cancelar'])
    }
    // Sessões ativas: as tarefas de fundo debaixo da sessão dona, sem as da fila.
    const s2 = texto(await ui.find({ key: 's-s2' }))
    expect(s2).toMatch(/Sessão Dois/)
    expect(s2).toMatch(/⌞ Subagente \(Explore\) procura código/)
    expect(s2).toMatch(/⌞ Teste pytest -q/)
    expect(await ui.find({ type: 'Text', text: /fila-build/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /não deve aparecer/ })).toBeUndefined()
    await ui.unmount()
  }

  // Minimizado (widget): só o resumo e o que roda.
  const mini = await $.ui.mount({ ...PANE, props: { ...PANE.props, placement: 'widget' }, surface: 'desktop' })
  expect((await mini.find({ type: 'Text', text: /1 rodando · 2 na fila/ }))?.text).toBeDefined()
  expect((await mini.find({ type: 'Text', text: /alfa/ }))?.text).toMatch(/há (29|30|31|32)s/)
  expect(await mini.find({ type: 'Text', text: /gama/ })).toBeUndefined()
  await mini.unmount()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'c-2-b' })
  await ui.press({ key: 't-2-b' })
  await ui.press({ key: 'x-3-c' })
  await ui.press({ key: 'm-1-a' })
  await ui.press({ key: 'pausa' })
  expect(rodados.map(a => a.slice(4).join(' '))).toEqual(['-Mover 2-b cima', '-Mover 2-b topo', '-Cancelar 3-c', '-Cancelar 1-a', '-Pausar'])
  expect(rodados[0]?.slice(0, 4)).toEqual(['pwsh', '-NoProfile', '-File', 'C:\\eu\\.claude\\scripts\\fila-build.ps1'])

  // Sessão sem id publicado (mod antigo nela): o id vem do título; sem achar, avisa e não abre nada.
  rodados.length = 0
  await ui.press({ key: 'ir-s2' })
  expect((await ui.find({ type: 'Text', text: /Não achei 'Sessão Dois'/ }))?.text).toBeDefined()
  expect(rodados).toEqual([])
  naLista.push({ sessionId: 'local_dois', title: 'Sessão Dois', cwd: 'K:\\src\\Outro' })
  await ui.press({ key: 'ir-s2' })
  expect(rodados).toEqual([['rundll32.exe', 'url.dll,FileProtocolHandler', 'claude://claude.ai/epitaxy/local_dois']])

  // Log da ficha rodando: últimas linhas.
  arq.set(`${DADOS}\\logs\\1-a.log`, Array.from({ length: 30 }, (_, i) => `linha ${i + 1}`).join('\r\n') + '\r\n')
  await ui.press({ key: 'l-1-a' })
  expect(await ui.find({ type: 'Text', text: /^linha 10$/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /^linha 30$/ }))?.text).toBe('linha 30')
  expect((await ui.find({ type: 'Text', text: /^linha 11$/ }))?.text).toBe('linha 11')

  // Pausada: a fila está parada, e a borda dela esmaece.
  arq.set(`${DADOS}\\pausa`, '')
  await ui.press({ key: 'l-1-a' })
  const parada = await ui.find({ key: 'sec-fila' })
  expect(parada?.props.borderDimColor).toBe(true)
  expect(texto(parada)).toMatch(/^Na fila pausada · 2/)
  await ui.unmount()
})

test('árvore de sessões: mãe com subagente, filha aninhada com subagente; inativa não aparece', async ($, on) => {
  const sessao = (id: string, extra: object) =>
    JSON.stringify({ sessao: id, nome: id, pasta: 'K:\\src', pid: 1, atualizado: agora, tarefas: [], ...extra })
  const arq: Arquivos = new Map([
    [
      `${DADOS}\\sessoes\\f.json`,
      sessao('f', {
        nome: 'Defeito na Sombra',
        ccd: 'local_f',
        ccdPai: 'local_m',
        modelo: 'claude-opus-5-5',
        esforco: 'high',
        esperando: true,
        subagentes: [{ id: 'a2', modelo: 'claude-haiku-5-5', descricao: 'Pesquisa sobre Vulkan', tipo: 'Explore', desde: agora }],
      }),
    ],
    [
      `${DADOS}\\sessoes\\m.json`,
      sessao('m', {
        nome: 'Breath of Fire IV',
        ccd: 'local_m',
        modelo: 'claude-opus-5-5[1m]',
        esforco: 'high',
        trabalhando: true,
        subagentes: [{ id: 'a1', modelo: 'claude-sonnet-5-5', descricao: 'Tradução', tipo: 'tradutor', desde: agora }],
      }),
    ],
    [`${DADOS}\\sessoes\\p.json`, sessao('p', { nome: 'Parada', ccd: 'local_p', modelo: 'claude-opus-5-5', trabalhando: false })],
  ])
  const rodados: string[][] = []
  disco(on, arq, rodados)
  on('command.register', () => ({ value: { command: 'fila' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: 'K:\\src', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'fila', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const linhas = (await ui.findAll({ type: 'Box' })).filter(b => /^s-/.test(b.key ?? ''))
    expect(linhas.map(b => b.key)).toEqual(['s-m', 's-f'])
    expect(linhas[0]?.props.paddingLeft).toBe(0)
    expect(linhas[1]?.props.paddingLeft).toBe(2)
    const mae = texto(linhas[0])
    expect(mae).toMatch(/^Breath of Fire IV (Ir para a sessão )?\(Opus 5\.5 High\) ●/)
    expect(mae).toMatch(/⌞ Sonnet 5\.5 \(Tradução\) \[Subagente\]/)
    const filha = texto(linhas[1])
    expect(filha).toMatch(/^• Defeito na Sombra (Ir para a sessão )?\(Opus 5\.5 High\) \(Sessão filha\) \?/)
    expect(filha).toMatch(/⌞ Haiku 5\.5 \(Pesquisa sobre Vulkan\) \[Subagente\]/)
    expect(await ui.find({ type: 'Text', text: /Parada/ })).toBeUndefined()
    if (surface === 'desktop') expect(texto(await ui.find({ key: 'e-f' }))).toMatch(/Esperando resposta sua/)
    else expect(filha).toMatch(/\? esperando resposta sua/)
    // Seções vazias: borda esmaecida.
    expect(texto(await ui.find({ key: 'sec-rodando' }))).toMatch(/^Rodando ○ parada/)
    expect((await ui.find({ key: 'sec-rodando' }))?.props.borderDimColor).toBe(true)
    expect(texto(await ui.find({ key: 'sec-fila' }))).toMatch(/^Na fila ○ vazia/)
    // Clicar no nome da sessão abre o link dela no app.
    rodados.length = 0
    await ui.press({ key: 'ir-f' })
    expect(rodados).toEqual([['rundll32.exe', 'url.dll,FileProtocolHandler', 'claude://claude.ai/epitaxy/local_f']])
    await ui.unmount()
  }
})

test('a sessão publica quem é, se trabalha, os subagentes vivos, e avisa pedidos e o fim do turno', async ($, on) => {
  const arq: Arquivos = new Map()
  disco(on, arq, [])
  const clock = mock.clock(on)
  const avisos: { text: string; title?: string; key?: string }[] = []
  on('ui.notify', (_, e) => {
    avisos.push({ text: e.text, title: e.title, key: e.key })
    return { value: { isSent: true as const, channel: 'client' } }
  })
  on('mcp.call', (_, e) => {
    expect([e.server, e.tool, e.args]).toEqual(['ccd_session_mgmt', 'get_session', { session_id: 'self' }])
    const j = { sessionId: 'local_f', parentSessionId: 'local_m', title: 'Defeito na Sombra', model: 'claude-opus-5-5', effort: 'high' }
    return { value: { content: [{ type: 'text' as const, text: JSON.stringify(j) }], isError: false } }
  })
  on('session.cwd', () => ({ value: 'K:\\src\\Jogo' }))
  on('command.register', () => ({ value: { command: 'fila' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'ag1' }))
  on('classic.Stop', () => ({}))
  on('classic.PermissionRequest', () => ({}))
  on('tool.call', () => ({ result: {} }))
  const lido = () => JSON.parse(arq.get(`${DADOS}\\sessoes\\s1.json`)!)

  await $.session.start({ cwd: 'K:\\src', surface: 'desktop', isInteractive: true })
  await clock.advance(2000)
  await $.turn.start({ text: 'oi', turnId: 't1' })
  expect(lido()).toMatchObject({ nome: 'Defeito na Sombra', ccd: 'local_f', ccdPai: 'local_m', modelo: 'claude-opus-5-5', esforco: 'high', trabalhando: true })

  await $.agent.spawn({
    prompt: 'procura',
    description: 'Pesquisa sobre Vulkan',
    subagentType: 'Explore',
    model: 'haiku',
    tool_use_id: 'tu1',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: true,
    fork: false,
  })
  expect(lido().subagentes).toMatchObject([{ id: 'ag1', modelo: 'claude-haiku-5-5', descricao: 'Pesquisa sobre Vulkan', tipo: 'Explore' }])

  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls' } })
  expect(lido().esperando).toBe(true)
  expect(avisos.at(-1)).toEqual({ text: 'Pede permissão: Bash', title: 'Defeito na Sombra', key: 'pedido-s1' })
  // Uma ferramenta que começa depois do pedido (de um subagente, por exemplo) não o responde.
  await $.tool.call({ tool: 'Read', file_path: 'K:\a.txt' })
  expect(lido().esperando).toBe(true)

  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'u1', reason: 'answer', agentId: 'ag1' })
  expect(lido().subagentes).toEqual([])
  expect(lido().trabalhando).toBe(true)

  await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'Pronto, testes passam.' })
  expect(avisos.at(-1)).toEqual({ text: 'Terminou: Pronto, testes passam.', title: 'Defeito na Sombra', key: 'fim-s1' })
  await $.turn.complete({ answer: 'Pronto', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(lido()).toMatchObject({ trabalhando: false, esperando: false })
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

test('faixa de limites acima do Rodando: usage no começo, session.measure atualiza; clicar no acesso remoto troca e relê', async ($, on) => {
  disco(on, new Map(), [])
  const clock = mock.clock(on)
  let remoto = 'off'
  let recusa = ''
  const pedidos: unknown[] = []
  const resposta = (text: string, isError = false) => ({ value: { content: [{ type: 'text' as const, text }], isError } })
  on('mcp.call', (_, e) => {
    if (e.tool !== 'set_remote_control') return resposta(JSON.stringify({ sessionId: 'local_f', remoteControlState: remoto }))
    pedidos.push(e.args)
    if (recusa) return resposta(recusa, true)
    remoto = (e.args as { enabled: boolean }).enabled ? 'on' : 'off'
    return resposta('{}')
  })
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200000 }, rateLimits: [{ kind: 'seven_day', percentUsed: 50 }] },
  }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.cwd', () => ({ value: 'K:\src' }))
  on('command.register', () => ({ value: { command: 'fila' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: 'K:\src', surface: 'desktop', isInteractive: true })
  await clock.advance(2000)
  await $.command.run({ command: 'fila', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const faixa = async () => texto(await ui.find({ key: 'faixa' }))
  expect(await faixa()).toMatch(/5h ▰▰▰▰▰▰ ∞ .*sem limite de 5 horas no seu plano.* 7d ▰▰▰▱▱▱ 50% .*⇄ desligado/)
  const chaves = (await ui.findAll({ type: 'Box' })).map(b => b.key).filter(k => k === 'faixa' || k === 'sec-rodando')
  expect(chaves).toEqual(['faixa', 'sec-rodando'])

  await $.session.measure({
    context: { window: 200000 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 100 }, { kind: 'seven_day', percentUsed: 51 }],
    changed: ['rateLimits'],
  })
  expect(await faixa()).toMatch(/5h ▰▰▰▰▰▰ 100% .*7d ▰▰▰▱▱▱ 51%/)
  expect(await faixa()).not.toMatch(/sem limite/)

  await ui.press({ key: 'remoto' })
  expect(await faixa()).toMatch(/⇄ ligado/)
  await ui.press({ key: 'remoto' })
  expect(await faixa()).toMatch(/⇄ desligado/)
  expect(pedidos).toEqual([
    { session_id: 'self', enabled: true },
    { session_id: 'self', enabled: false },
  ])
  // Recusa do app aparece no painel, e o estado fica o que o app diz.
  recusa = 'recusado pelo app'
  await ui.press({ key: 'remoto' })
  expect((await ui.find({ type: 'Text', text: /Não deu: recusado pelo app/ }))?.text).toBeDefined()
  expect(await faixa()).toMatch(/⇄ desligado/)

  // Indisponível: só o indicador, sem clique. Sem assinatura: —.
  remoto = 'unavailable'
  await clock.advance(60000)
  await $.session.measure({ context: { window: 200000 }, rateLimits: [], changed: ['rateLimits'] })
  expect(await faixa()).toMatch(/5h — .*7d — .*⇄ indisponível/)
  expect(await ui.find({ key: 'remoto' })).toBeUndefined()
  await ui.unmount()
})
