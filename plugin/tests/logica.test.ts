import { expect, test } from 'claude-code/testing'

import type { Ficha, Hist, Velha } from '../types'
import { pontosEmUso, acessoRemoto, curto, dur, estimativa, fimMaisNovo, idNaLista, medidores, novosNoHistorico, ordenarFila, textoDoAviso, tipoDoComando, ultimasLinhas } from '../hooks/logica'

const f = (id: string, estado: Ficha['estado'] = 'espera') => ({ id, estado }) as Ficha
const h = (o: Partial<Hist>) => ({ tipo: 'Build', pasta: 'K:\\a', cancelado: false, segundos: 10, codigo: 0, fim: '', nome: 'n', ...o }) as Hist

test('ordem: primeiro ordem.txt, depois por chegada; rodando fica fora', async () => {
  const r = ordenarFila([f('3'), f('1'), f('2'), f('0', 'rodando'), f('4')], ['4', 'x', '2', '4'])
  expect(r.map(x => x.id)).toEqual(['4', '2', '1', '3'])
  // quem já segura uma pasta (um -Sozinho com 'sozinho') fica na frente mesmo com outro no topo
  const s1 = { ...f('5'), seguras: ['sozinho'] } as Ficha
  expect(ordenarFila([f('6'), s1], ['6']).map(x => x.id)).toEqual(['5', '6'])
})

test('pontos em uso: peso da ficha, 2 por vaga na ficha velha e 2 por lock antigo', async () => {
  const r = (o: Partial<Ficha>) => ({ ...f('x', 'rodando'), ...o }) as Ficha
  const v = (vaga: string) => ({ vaga, nome: 'n', desde: '' }) as Velha
  expect(pontosEmUso([], [])).toBe(0)
  expect(pontosEmUso([r({ peso: 1 }), r({ peso: 2 })], [])).toBe(3)
  expect(pontosEmUso([r({ vagas: 1 }), r({ vagas: 2 })], [])).toBe(6)
  expect(pontosEmUso([], [v('lock'), v('sozinho')])).toBe(2)
})

test('tipo deduzido igual ao script', async () => {
  expect(tipoDoComando('cargo build --release')).toBe('Build')
  expect(tipoDoComando('ctest -j4')).toBe('Teste')
  expect(tipoDoComando('python -m pytest')).toBe('Teste')
  expect(tipoDoComando('python jogo-oculto.py x')).toBe('Jogo')
  expect(tipoDoComando('K:\\src\\latest\\run.ps1')).toBe('Comando')
})

test('estimativa: média das 5 últimas do mesmo tipo e pasta, sem canceladas', async () => {
  const hist = [h({ segundos: 1000 }), ...[10, 20, 30, 40, 50].map(s => h({ segundos: s })), h({ segundos: 999, cancelado: true }), h({ segundos: 5, tipo: 'Teste' }), h({ segundos: 7, pasta: 'K:\\b' })]
  expect(estimativa(hist, 'Build', 'k:\\A')).toBe(30)
  expect(estimativa(hist, 'Jogo', 'K:\\a')).toBeUndefined()
})

test('formatos', async () => {
  expect(dur(5)).toBe('5s')
  expect(dur(192)).toBe('3m12s')
  expect(dur(3700)).toBe('1h01m')
  expect(curto('pwsh -File "C:\\Users\\eu\\.claude\\scripts\\fila-build.ps1" -Nome x')).toBe('pwsh -File fila-build.ps1 -Nome x')
  expect(curto('a'.repeat(100), 10)).toBe('aaaaaaaaa…')
  expect(ultimasLinhas('a\r\nb\r\nc\r\n', 2)).toEqual(['b', 'c'])
})

test('avisos: só o que terminou depois do último visto', async () => {
  const hist = [h({ fim: '2026-01-01T00:00:01Z' }), h({ fim: '2026-01-01T00:00:03Z', codigo: 2, nome: 'jogo' })]
  const novos = novosNoHistorico(hist, '2026-01-01T00:00:02Z')
  expect(novos.length).toBe(1)
  // fuso diferente: 00:00:03-03:00 é depois de 02:00:00Z
  expect(novosNoHistorico([h({ fim: '2026-01-01T00:00:03-03:00' })], '2026-01-01T02:00:00Z').length).toBe(1)
  expect(fimMaisNovo([h({ fim: '2026-01-01T00:00:03-03:00' }), h({ fim: '2026-01-01T02:00:00Z' })])).toBe('2026-01-01T00:00:03-03:00')
  expect(textoDoAviso(novos[0]!)).toBe("✗ Build 'jogo' falhou (código 2, 10s)")
  expect(textoDoAviso(h({ codigo: 0, segundos: 192 }))).toBe("✓ Build 'n' terminou (código 0, 3m12s)")
  expect(textoDoAviso(h({ codigo: 1, cancelado: true }))).toMatch(/^■ .* cancelado/)
})

test('sessão no app: pelo título; a pasta desempata e é exigida quando o nome é só o da pasta', async () => {
  const lista = [
    { sessionId: 'a', title: 'Um', cwd: 'K:/x' },
    { sessionId: 'b', title: 'Dois', cwd: 'K:/y' },
    { sessionId: 'c', title: 'Dois', cwd: 'K:/Z' },
    { sessionId: 'd', title: 'Jogo', cwd: 'K:/outro' },
  ]
  expect(idNaLista(lista, { nome: 'Um', pasta: 'K:/qualquer' })).toBe('a')
  expect(idNaLista(lista, { nome: 'Dois', pasta: 'K:/z' })).toBe('c')
  expect(idNaLista(lista, { nome: 'Dois', pasta: 'K:/w' })).toBeUndefined()
  expect(idNaLista(lista, { nome: 'Jogo', pasta: 'K:/Jogo' })).toBeUndefined()
})

test('limites: porcentagem e barra; sem a janela de 5 horas, ∞; sem leitura nenhuma, —', async () => {
  const barras = (l: Parameters<typeof medidores>[0]) => medidores(l).map(m => `${m.rotulo} ${m.cheio}${m.vazio} ${m.valor}`)
  const max = [{ kind: 'five_hour', percentUsed: 33.5 }, { kind: 'seven_day', percentUsed: 80 }]
  expect(barras(max)).toEqual(['5h ▰▰▱▱▱▱ 34%', '7d ▰▰▰▰▰▱ 80%'])
  expect(medidores(max).map(m => [m.alto, m.dica])).toEqual([[false, undefined], [true, undefined]])
  const ultra = [{ kind: 'seven_day', percentUsed: 0 }]
  expect(barras(ultra)).toEqual(['5h ▰▰▰▰▰▰ ∞', '7d ▱▱▱▱▱▱ 0%'])
  expect(medidores(ultra)[0]).toMatchObject({ alto: false, dica: 'sem limite de 5 horas no seu plano' })
  expect(barras([])).toEqual(['5h  —', '7d  —'])
  // Só o limite de gasto de um gateway não é plano sem janela de 5 horas.
  expect(barras([{ kind: 'spend_limit', percentUsed: 10 }])).toEqual(['5h  —', '7d  —'])
})

test('acesso remoto: o clique pede o contrário; indisponível ou sem leitura não tem clique', async () => {
  expect(['on', 'off', 'connecting', 'unavailable', undefined].map(e => [acessoRemoto(e).palavra, acessoRemoto(e).ligar])).toEqual([
    ['ligado', false],
    ['desligado', true],
    ['conectando', false],
    ['indisponível', undefined],
    ['indisponível', undefined],
  ])
})
