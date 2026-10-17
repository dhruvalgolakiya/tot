import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import "./workspace.css";

/**
 * Syntax colors for the workspace panel's diffs and file previews: highlight.js with the languages a project
 * usually holds, one line at a time (what a virtualized list renders). Colors follow the theme (workspace.css).
 */

const LANGUAGES = { bash, c, cpp, csharp, css, dockerfile, go, ini, java, javascript, json, kotlin, makefile, markdown, php, python, ruby, rust, scss, sql, swift, typescript, xml, yaml };
for (const [name, language] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, language);

const BY_EXTENSION: Record<string, keyof typeof LANGUAGES> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", jsonc: "json", json5: "json",
  css: "css", scss: "scss", sass: "scss",
  html: "xml", htm: "xml", xml: "xml", svg: "xml", vue: "xml", svelte: "xml", plist: "xml",
  md: "markdown", mdx: "markdown", markdown: "markdown",
  py: "python", rb: "ruby", rs: "rust", go: "go", java: "java", kt: "kotlin", kts: "kotlin", swift: "swift",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp", cs: "csharp", php: "php", sql: "sql",
  sh: "bash", bash: "bash", zsh: "bash", yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", env: "ini",
};

const BY_NAME: Record<string, keyof typeof LANGUAGES> = { dockerfile: "dockerfile", makefile: "makefile", gemfile: "ruby", rakefile: "ruby" };

/** The language to color a file in, by its name; null for plain text. */
export function languageFor(path: string): string | null {
  const name = path.split("/").pop()!.toLowerCase();
  if (BY_NAME[name]) return BY_NAME[name];
  const extension = name.includes(".") ? name.split(".").pop()! : "";
  return BY_EXTENSION[extension] ?? null;
}

const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** One line as highlighted HTML (escaped either way). Very long lines stay plain. */
export function highlightLine(text: string, language: string | null): string {
  if (!language || text.length > 2000) return escape(text);
  try {
    return hljs.highlight(text, { language, ignoreIllegals: true }).value;
  } catch {
    return escape(text);
  }
}

/** A whole file as highlighted HTML lines (multi-line comments and strings keep their color), split per line. */
export function highlightLines(text: string, language: string | null): string[] {
  if (!language || text.length > 1_000_000) return text.split("\n").map(escape);
  let html: string;
  try {
    html = hljs.highlight(text, { language, ignoreIllegals: true }).value;
  } catch {
    return text.split("\n").map(escape);
  }
  // Spans open across a line break are closed at its end and opened again on the next line.
  const lines: string[] = [];
  const open: string[] = [];
  for (const line of html.split("\n")) {
    let out = open.join("");
    for (const tag of line.matchAll(/<span [^>]*>|<\/span>/g)) {
      if (tag[0] === "</span>") open.pop();
      else open.push(tag[0]);
    }
    out += line + "</span>".repeat(open.length);
    lines.push(out);
  }
  return lines;
}
