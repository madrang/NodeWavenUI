/**
 * The shell command display parser: it reads one submitted command and answers the stage model
 * the approval card and the chat render. It serves display only, never execution: the system
 * shell stays the authority on what a command does. The parser knows the operators the approval
 * flow needs to separate, the quoting the words carry, and the expansion forms it must mark
 * instead of resolve.
 */

/** One word of a stage, as typed: the quotes stay in the text, expansions carry their mark. */
export interface ShellWord {
  readonly text: string;
  /** True when the word holds a `$` expansion outside single quotes. */
  readonly expansion: boolean;
}

/** One redirection of a stage. */
export interface ShellRedirect {
  /** The redirection operator as typed: `>`, `>>`, `<`, `2>`, `2>>`. */
  readonly kind: string;
  readonly target: string;
}

/** One stage of a command: the program, its arguments, its redirects, and the operator after. */
export interface ShellStage {
  readonly program: ShellWord;
  readonly args: readonly ShellWord[];
  readonly redirects: readonly ShellRedirect[];
  /** The operator that joins this stage to the next: `&&`, `||`, `|`, `;`, or null at the end. */
  readonly operator: '&&' | '||' | '|' | ';' | null;
}

/** The redirect operators the parser separates, longest first so `2>>` wins over `2>`. */
const REDIRECT_OPS: readonly string[] = ['2>>', '2>', '>>', '>', '<'];

/** Reads the length of the operator at one position, or 0 when none sits there. */
function operatorLength(text: string, index: number): number {
  const two = text.slice(index, index + 2);
  if (two === '&&' || two === '||') {
    return 2;
  }
  if (text[index] === '|' || text[index] === ';') {
    return 1;
  }
  return 0;
}

/** Reads the length of the redirection at one position, or 0 when none sits there. */
function redirectLength(text: string, index: number): number {
  for (const op of REDIRECT_OPS) {
    if (text.startsWith(op, index)) {
      return op.length;
    }
  }
  return 0;
}

/** True when a word holds an expansion: a `$` that no single quote hid. */
function holdsExpansion(word: string): boolean {
  let single = false;
  for (let index = 0; index < word.length; index += 1) {
    const char = word[index]!;
    if (char === "'") {
      single = !single;
      continue;
    }
    if (char === '\\' && index + 1 < word.length) {
      index += 1;
      continue;
    }
    if (char === '$' && !single) {
      return true;
    }
  }
  return false;
}

/**
 * Parses one command into its stages.
 *
 * @param text The command exactly as submitted.
 * @returns The stages in order. Empty input answers no stage. A stage with no program word
 *   keeps a blank program, so a damaged tail still renders.
 */
export function parseShellCommand(text: string): readonly ShellStage[] {
  const stages: { words: ShellWord[]; redirects: ShellRedirect[]; operator: ShellStage['operator'] }[] = [];
  let current = { words: [] as ShellWord[], redirects: [] as ShellRedirect[], operator: null as ShellStage['operator'] };
  let word = '';
  let wordStarted = false;
  const pushWord = (): void => {
    if (wordStarted && word.length > 0) {
      current.words.push({ text: word, expansion: holdsExpansion(word) });
    }
    word = '';
    wordStarted = false;
  };
  const pushStage = (operator: ShellStage['operator']): void => {
    pushWord();
    current.operator = operator;
    stages.push(current);
    current = { words: [] as ShellWord[], redirects: [] as ShellRedirect[], operator: null as ShellStage['operator'] };
  };
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === "'") {
      word += char;
      wordStarted = true;
      index += 1;
      while (index < text.length && text[index] !== "'") {
        word += text[index];
        index += 1;
      }
      if (index < text.length) {
        word += "'";
        index += 1;
      }
      continue;
    }
    if (char === '"') {
      word += char;
      wordStarted = true;
      index += 1;
      while (index < text.length && text[index] !== '"') {
        if (text[index] === '\\' && index + 1 < text.length) {
          word += text[index]!;
          index += 1;
        }
        word += text[index];
        index += 1;
      }
      if (index < text.length) {
        word += '"';
        index += 1;
      }
      continue;
    }
    if (char === '\\' && index + 1 < text.length) {
      word += char;
      word += text[index + 1]!;
      wordStarted = true;
      index += 2;
      continue;
    }
    if (/\s/.test(char)) {
      pushWord();
      index += 1;
      continue;
    }
    const op = operatorLength(text, index);
    if (op > 0) {
      pushStage(op === 2 ? (text.slice(index, index + 2) as '&&' | '||') : (char as '|' | ';'));
      index += op;
      continue;
    }
    const redirect = redirectLength(text, index);
    if (redirect > 0) {
      pushWord();
      const kind = text.slice(index, index + redirect);
      index += redirect;
      let target = '';
      while (index < text.length && /\s/.test(text[index]!)) {
        index += 1;
      }
      while (index < text.length && !/\s/.test(text[index]!) && operatorLength(text, index) === 0) {
        target += text[index];
        index += 1;
      }
      current.redirects.push({ kind, target });
      continue;
    }
    word += char;
    wordStarted = true;
    index += 1;
  }
  pushStage(null);
  return stages
    .filter((stage) => stage.words.length > 0 || stage.redirects.length > 0)
    .map((stage) => ({
      program: stage.words[0] ?? { text: '', expansion: false },
      args: stage.words.slice(1),
      redirects: stage.redirects,
      operator: stage.operator,
    }));
}
