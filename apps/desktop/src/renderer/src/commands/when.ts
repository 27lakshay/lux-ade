// `when` clauses decide whether a keybinding or command applies, as in VS Code: context keys
// combined with `!`, `&&`, `||`, `==`, `!=` and parentheses, e.g.
//   `focus == 'terminal' && !inputFocus`
// A bare key is true when its context value is truthy. Comparisons compare against a quoted string,
// a number, true or false.

export type Context = Readonly<Record<string, unknown>>
type Token = { kind: 'key' | 'string' | 'op' | 'paren'; value: string }

function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  const pattern = /\s*(?:(&&|\|\||==|!=|!)|([()])|'([^']*)'|([A-Za-z0-9_.:-]+))/y
  let index = 0
  while (index < source.length) {
    if (/^\s*$/.test(source.slice(index))) break
    pattern.lastIndex = index
    const match = pattern.exec(source)
    if (!match) throw new Error(`Invalid when clause at ${index}: ${source}`)
    if (match[1]) tokens.push({ kind: 'op', value: match[1] })
    else if (match[2]) tokens.push({ kind: 'paren', value: match[2] })
    else if (match[3] !== undefined) tokens.push({ kind: 'string', value: match[3] })
    else tokens.push({ kind: 'key', value: match[4] })
    index = pattern.lastIndex
  }
  return tokens
}

type Expression =
  | { kind: 'key'; name: string }
  | { kind: 'not'; operand: Expression }
  | { kind: 'and' | 'or'; left: Expression; right: Expression }
  | { kind: 'equals' | 'differs'; name: string; value: string }

function parse(tokens: Token[]): Expression {
  let position = 0
  const peek = (): Token | undefined => tokens[position]
  const take = (): Token => {
    const token = tokens[position++]
    if (!token) throw new Error('Unexpected end of when clause')
    return token
  }
  const primary = (): Expression => {
    const token = take()
    if (token.kind === 'op' && token.value === '!') return { kind: 'not', operand: primary() }
    if (token.kind === 'paren' && token.value === '(') {
      const inner = or()
      if (take().value !== ')') throw new Error('Missing ) in when clause')
      return inner
    }
    if (token.kind !== 'key') throw new Error(`Unexpected ${token.value} in when clause`)
    const next = peek()
    if (next?.kind === 'op' && (next.value === '==' || next.value === '!=')) {
      take()
      const value = take()
      if (value.kind !== 'string' && value.kind !== 'key') throw new Error('Expected a value after a comparison')
      return { kind: next.value === '==' ? 'equals' : 'differs', name: token.value, value: value.value }
    }
    return { kind: 'key', name: token.value }
  }
  const and = (): Expression => {
    let left = primary()
    while (peek()?.value === '&&') {
      take()
      left = { kind: 'and', left, right: primary() }
    }
    return left
  }
  const or = (): Expression => {
    let left = and()
    while (peek()?.value === '||') {
      take()
      left = { kind: 'or', left, right: and() }
    }
    return left
  }
  const expression = or()
  if (position !== tokens.length) throw new Error(`Unexpected ${tokens[position]?.value} in when clause`)
  return expression
}

function evaluate(expression: Expression, context: Context): boolean {
  switch (expression.kind) {
    case 'key':
      return Boolean(context[expression.name])
    case 'not':
      return !evaluate(expression.operand, context)
    case 'and':
      return evaluate(expression.left, context) && evaluate(expression.right, context)
    case 'or':
      return evaluate(expression.left, context) || evaluate(expression.right, context)
    case 'equals':
      return String(context[expression.name]) === expression.value
    case 'differs':
      return String(context[expression.name]) !== expression.value
  }
}

const cache = new Map<string, Expression>()

/** Whether `clause` holds in `context`. An absent clause always holds. Throws on invalid syntax. */
export function whenHolds(clause: string | undefined, context: Context): boolean {
  if (!clause?.trim()) return true
  let expression = cache.get(clause)
  if (!expression) {
    expression = parse(tokenize(clause))
    cache.set(clause, expression)
  }
  return evaluate(expression, context)
}
