import { expect, test } from 'claude-code/testing'

import type { Ficha, Hist } from '../types'
import { curto, dur, estimativa, fimMaisNovo, novosNoHistorico, ordenarFila, textoDoAviso, tipoDoComando, ultimasLinhas } from '../hooks/logica'

const f = (id: string, estado: Ficha['estado'] = 'espera') => ({ id, estado }) as Ficha
const h = (o: Partial<Hist>) => ({ tipo: 'Build', pasta: 'K:\\a', cancelado: false, segundos: 10, codigo: 0, fim: '', nome: 'n', ...o }) as Hist

test('ordem: primeiro ordem.txt, depois por chegada; rodando fica fora', async () => {
  const r = ordenarFila([f('3'), f('1'), f('2'), f('0', 'rodando'), f('4')], ['4', 'x', '2', '4'])
  expect(r.map(x => x.id)).toEqual(['4', '2', '1', '3'])
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
