import type { Path } from "effect"
import sh from "mvdan-sh"

export interface ShellCall {
  readonly cwd: string
  readonly words: ReadonlyArray<string | null>
}

const { syntax } = sh

const isCall = (node: sh.Node): node is sh.CallExpr => syntax.NodeType(node) === "CallExpr"
const isStatement = (node: sh.Node): node is sh.Stmt => syntax.NodeType(node) === "Stmt"
const isBinary = (node: sh.Node): node is sh.BinaryCmd => syntax.NodeType(node) === "BinaryCmd"
const isBlock = (node: sh.Node): node is sh.Block => syntax.NodeType(node) === "Block"
const isIf = (node: sh.Node): node is sh.IfClause => syntax.NodeType(node) === "IfClause"
const isWhile = (node: sh.Node): node is sh.WhileClause => syntax.NodeType(node) === "WhileClause"
const isFor = (node: sh.Node): node is sh.ForClause => syntax.NodeType(node) === "ForClause"
const isCase = (node: sh.Node): node is sh.CaseClause => syntax.NodeType(node) === "CaseClause"
const isSubshell = (node: sh.Node): node is sh.Subshell => syntax.NodeType(node) === "Subshell"
const isSubstitution = (node: sh.Node): node is sh.CmdSubst => syntax.NodeType(node) === "CmdSubst"
const isLiteral = (node: sh.Node): node is sh.Lit => syntax.NodeType(node) === "Lit"
const isSingleQuoted = (node: sh.Node): node is sh.SglQuoted => syntax.NodeType(node) === "SglQuoted"
const isDoubleQuoted = (node: sh.Node): node is sh.DblQuoted => syntax.NodeType(node) === "DblQuoted"

const wordOf = (parts: ReadonlyArray<sh.WordPart>, quoted = false): string | null => {
  let word = ""
  for (const part of parts) {
    if (isLiteral(part)) {
      word += part.Value.replace(quoted ? /\\([$\u0060"\\\n])/g : /\\(.)/gs, (_, escaped: string) => escaped === "\n" ? "" : escaped)
    } else if (isSingleQuoted(part)) {
      word += part.Value
    } else if (isDoubleQuoted(part)) {
      const text = wordOf(part.Parts, true)
      if (text === null) return null
      word += text
    } else {
      return null
    }
  }
  return word
}

export const shellCalls = (command: string, cwd: string, path: Path.Path): ReadonlyArray<ShellCall> => {
  const file = syntax.NewParser().Parse(command)
  const bytes = new TextEncoder().encode(command)
  const text = new TextDecoder()
  const calls: Array<ShellCall> = []
  const unique = (directories: ReadonlyArray<string>): Array<string> => [...new Set(directories)]
  const sequence = (statements: ReadonlyArray<sh.Stmt | null>, directory: string): Array<string> =>
    statements.reduce((directories, statement) => unique(directories.flatMap((dir) => visit(statement, dir))), [directory])
  const nested = (node: sh.Node, directory: string) => {
    syntax.Walk(node, (child: sh.Node | null) => {
      if (child === null) return false
      if (child === node) return true
      if (!isStatement(child) && !isSubstitution(child)) return true
      visit(child, directory)
      return false
    })
  }
  const visitStatement = (statement: sh.Stmt, directory: string): Array<string> => {
    for (const redirection of statement.Redirs) {
      if (redirection !== null) nested(redirection, directory)
    }
    const next = visit(statement.Cmd, directory)
    return statement.Background ? [directory] : next
  }
  const visitCall = (call: sh.CallExpr, directory: string): Array<string> => {
    nested(call, directory)
    const words = call.Args.map((word) => word === null ? null : wordOf(word.Parts))
    const [tool, dest] = words
    if (tool === "cd" && typeof dest === "string" && !dest.startsWith("-")) {
      return [path.resolve(directory, dest)]
    }
    if (words.length > 0) calls.push({ cwd: directory, words })
    return tool === "exit" ? [] : [directory]
  }
  const visitBinary = (binary: sh.BinaryCmd, directory: string): Array<string> => {
    const afterLeft = visit(binary.X, directory)
    const operator = binary.OpPos.Offset()
    const op = text.decode(bytes.subarray(operator, operator + 2))
    if (op === "&&" || op === "||") {
      const rightDirectories = op === "&&" ? afterLeft : unique([directory, ...afterLeft])
      return unique([...afterLeft, ...rightDirectories.flatMap((dir) => visit(binary.Y, dir))])
    }
    visit(binary.Y, directory)
    return [directory]
  }
  const visitCase = (clause: sh.CaseClause, directory: string): Array<string> => {
    if (clause.Word !== null) nested(clause.Word, directory)
    return unique([directory, ...clause.Items.flatMap((item) => {
      if (item === null) return []
      for (const pattern of item.Patterns) {
        if (pattern !== null) nested(pattern, directory)
      }
      return sequence(item.Stmts, directory)
    })])
  }
  const visitCompound = (node: sh.Node, directory: string): Array<string> => {
    if (isIf(node)) {
      return unique(sequence(node.Cond, directory).flatMap((dir) => [
        ...sequence(node.Then, dir), ...visit(node.Else, dir)
      ]))
    }
    if (isWhile(node)) {
      const afterCondition = sequence(node.Cond, directory)
      return unique([...afterCondition, ...afterCondition.flatMap((dir) => sequence(node.Do, dir))])
    }
    if (isFor(node)) {
      nested(node.Loop, directory)
      return unique([directory, ...sequence(node.Do, directory)])
    }
    if (isCase(node)) return visitCase(node, directory)
    if (isBlock(node)) return sequence(node.Stmts, directory)
    if (isSubshell(node) || isSubstitution(node)) sequence(node.Stmts, directory)
    else nested(node, directory)
    return [directory]
  }
  const visit = (node: sh.Node | null, directory: string): Array<string> => {
    if (node === null) return [directory]
    if (isStatement(node)) return visitStatement(node, directory)
    if (isCall(node)) return visitCall(node, directory)
    if (isBinary(node)) return visitBinary(node, directory)
    return visitCompound(node, directory)
  }
  sequence(file.Stmts, cwd)
  return calls
}
