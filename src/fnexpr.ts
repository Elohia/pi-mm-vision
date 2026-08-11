/**
 * fnexpr — 极简数学表达式求值器（零依赖 · 无 eval）
 * ==================================================
 * 递归下降解析器：支持函数曲线渲染所需的全部运算。
 * 安全：白名单函数 + 自写 tokenizer/parser，不执行任意代码。
 *
 * 语法：
 *   数字：12, 3.14, -2
 *   变量：x / t（由调用方指定）
 *   常量：pi, e
 *   运算：+ - * / ^（^ 右结合）
 *   函数：sin cos tan asin acos atan sqrt abs log ln exp floor ceil sign min(a,b) max(a,b)
 *   括号：( )
 *
 * 用法：
 *   const f = compileExpr("sin(x)*x/10");
 *   f(50)   // 0.3
 */
export type FnExpr = (v: number) => number;

// ==================== Tokenizer ====================

type Token =
  | { t: "num"; v: number }
  | { t: "var" }
  | { t: "op"; v: string }
  | { t: "fn"; v: string }
  | { t: "lp" }
  | { t: "rp" }
  | { t: "comma" };

const FN_1 = new Set(["sin", "cos", "tan", "asin", "acos", "atan", "sqrt", "abs", "log", "ln", "exp", "floor", "ceil", "sign"]);
const FN_2 = new Set(["min", "max", "pow", "mod"]);
const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E };

function tokenize(src: string): Token[] {
  const toks: Token[] = [];
  let i = 0;
  const s = src.toLowerCase();
  while (i < s.length) {
    const c = s[i];
    if (c === " " || c === "\t") { i++; continue; }
    if (c >= "0" && c <= "9" || c === ".") {
      let j = i;
      while (j < s.length && (s[j] >= "0" && s[j] <= "9" || s[j] === ".")) j++;
      const v = parseFloat(s.slice(i, j));
      if (isNaN(v)) throw new Error(`数字解析失败: "${s.slice(i, j)}"`);
      toks.push({ t: "num", v });
      i = j;
      continue;
    }
    if (c >= "a" && c <= "z") {
      let j = i;
      while (j < s.length && (s[j] >= "a" && s[j] <= "z" || s[j] >= "0" && s[j] <= "9")) j++;
      const word = s.slice(i, j);
      i = j;
      if (word === "x" || word === "t" || word === "y") { toks.push({ t: "var" }); continue; }
      if (word === "mod") { toks.push({ t: "op", v: "%" }); continue; }
      if (word in CONSTS) { toks.push({ t: "num", v: CONSTS[word] }); continue; }
      if (FN_1.has(word) || FN_2.has(word)) { toks.push({ t: "fn", v: word }); continue; }
      throw new Error(`未知标识符: "${word}"`);
    }
    if (c === "+" || c === "-" || c === "*" || c === "/" || c === "^" || c === "%") { toks.push({ t: "op", v: c }); i++; continue; }
    if (c === "(") { toks.push({ t: "lp" }); i++; continue; }
    if (c === ")") { toks.push({ t: "rp" }); i++; continue; }
    if (c === ",") { toks.push({ t: "comma" }); i++; continue; }
    throw new Error(`无法解析字符: "${c}"`);
  }
  return toks;
}

// ==================== 递归下降解析 ====================
// expr   := term (('+'|'-') term)*
// term   := factor (('*'|'/') factor)*
// factor := unary ('^' factor)?          ← ^ 右结合
// unary  := ('-'|'+')* postfix
// postfix:= atom | fn '(' expr (',' expr)? ')'
// atom   := num | var | '(' expr ')'

export function compileExpr(src: string): FnExpr {
  const toks = tokenize(src);
  let pos = 0;

  const peek = () => toks[pos];
  const next = () => toks[pos++];
  const expect = (t: Token["t"], what: string) => {
    const tk = peek();
    if (!tk || tk.t !== t) throw new Error(`期望 ${what}，实际: ${tk ? JSON.stringify(tk) : "表达式结束"}`);
    return next() as any;
  };

  function parseExpr(): FnExpr {
    let left = parseTerm();
    for (;;) {
      const tk = peek();
      if (tk?.t === "op" && (tk.v === "+" || tk.v === "-")) {
        next();
        const right = parseTerm();
        const l = left;
        left = tk.v === "+" ? (v) => l(v) + right(v) : (v) => l(v) - right(v);
      } else break;
    }
    return left;
  }

  function parseTerm(): FnExpr {
    let left = parseFactor();
    for (;;) {
      const tk = peek();
      if (tk?.t === "op" && (tk.v === "*" || tk.v === "/" || tk.v === "%")) {
        next();
        const right = parseFactor();
        const l = left;
        left = tk.v === "*" ? (v) => l(v) * right(v) : tk.v === "/" ? (v) => l(v) / right(v) : (v) => l(v) % right(v);
      } else break;
    }
    return left;
  }

  function parseFactor(): FnExpr {
    return parseUnary();
  }

  function parseUnary(): FnExpr {
    const tk = peek();
    if (tk?.t === "op" && (tk.v === "-" || tk.v === "+")) {
      next();
      const inner = parseUnary();
      return tk.v === "-" ? (v) => -inner(v) : inner;
    }
    return parsePower();
  }

  /** 幂：右结合，优先级高于一元负号（-x^2 = -(x^2)） */
  function parsePower(): FnExpr {
    const left = parsePostfix();
    const tk = peek();
    if (tk?.t === "op" && tk.v === "^") {
      next();
      const right = parsePower();
      return (v) => Math.pow(left(v), right(v));
    }
    return left;
  }

  function parsePostfix(): FnExpr {
    const tk = peek();
    if (!tk) throw new Error("表达式意外结束");
    if (tk.t === "num") { next(); const n = tk.v; return () => n; }
    if (tk.t === "var") { next(); return (v) => v; }
    if (tk.t === "lp") {
      next();
      const inner = parseExpr();
      expect("rp", ")");
      return inner;
    }
    if (tk.t === "fn") {
      next();
      const name = tk.v;
      expect("lp", "(");
      const a = parseExpr();
      if (FN_2.has(name)) {
        expect("comma", ",");
        const b = parseExpr();
        expect("rp", ")");
        return (v) => {
          const av = a(v), bv = b(v);
          switch (name) {
            case "min": return Math.min(av, bv);
            case "max": return Math.max(av, bv);
            case "pow": return Math.pow(av, bv);
            case "mod": return av % bv;
          }
          return NaN;
        };
      }
      expect("rp", ")");
      return (v) => {
        const av = a(v);
        switch (name) {
          case "sin": return Math.sin(av);
          case "cos": return Math.cos(av);
          case "tan": return Math.tan(av);
          case "asin": return Math.asin(av);
          case "acos": return Math.acos(av);
          case "atan": return Math.atan(av);
          case "sqrt": return Math.sqrt(Math.max(av, 0));
          case "abs": return Math.abs(av);
          case "log": return Math.log10(av);
          case "ln": return Math.log(av);
          case "exp": return Math.exp(av);
          case "floor": return Math.floor(av);
          case "ceil": return Math.ceil(av);
          case "sign": return Math.sign(av);
        }
        return NaN;
      };
    }
    throw new Error(`意外的 token: ${JSON.stringify(tk)}`);
  }

  const fn = parseExpr();
  if (pos < toks.length) throw new Error(`表达式尾部多余内容: ${JSON.stringify(toks[pos])}`);
  return fn;
}

/** 便捷：解析并求值单点 */
export function evalExpr(src: string, v: number): number {
  return compileExpr(src)(v);
}
