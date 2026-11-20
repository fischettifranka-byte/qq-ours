#!/usr/bin/env python3
"""P0 patch for qqours_main.js: atomic queue consume + path whitelist + dead letter."""
import io, sys

SRC = "/root/workspace/qq-review/src/qqours_main.js"
DST = "/root/workspace/qq-review/src/qqours_main.patched.js"
s = io.open(SRC, encoding="utf-8").read()
orig = s
applied = []

def rep(old, new, tag):
    global s
    n = s.count(old)
    if n != 1:
        print("!! %s : expected 1 hit, got %d" % (tag, n))
        sys.exit(2)
    s = s.replace(old, new)
    applied.append(tag)

# A. constants
rep('const LOGF = path.join(OUT, "boot.log");',
    'const LOGF = path.join(OUT, "boot.log");\n'
    'const FILES_BASE = path.join(OUT, "files");\n'
    'const DEAD_LETTER = path.join(OUT, "dead_letter.jsonl");',
    "A constants")

# B. helpers after status()
status_line = 'function status(obj) { try { fs.writeFileSync(path.join(OUT, "status.json"), JSON.stringify(obj, null, 2)); } catch (e) {} }'
helpers = status_line + """

// ---- P0: queue cursor / path whitelist / dead letter ----
const queueCursors = new Map();
// append-only queue: consume by byte cursor, never truncate, keep half line for next round
function readNewLines(qf) {
  var st = queueCursors.get(qf);
  if (!st) { st = { off: 0 }; queueCursors.set(qf, st); }
  var fd;
  try { fd = fs.openSync(qf, "r"); } catch (e) { return []; }
  try {
    var size = fs.fstatSync(fd).size;
    if (size < st.off) st.off = 0;
    if (size === st.off) return [];
    var buf = Buffer.alloc(size - st.off);
    var got = 0;
    try { got = fs.readSync(fd, buf, 0, buf.length, st.off); } catch (e) { return []; }
    if (!got) return [];
    var nl = buf.lastIndexOf(String.fromCharCode(10));
    if (nl === -1) return [];
    var chunk = buf.slice(0, nl + 1);
    st.off += chunk.length;
    return chunk.toString("utf8").split(String.fromCharCode(10)).filter(function (x) { return x.trim(); });
  } finally { try { fs.closeSync(fd); } catch (e) {} }
}
function safePath(p) {
  try {
    if (!p) return null;
    var rp = fs.realpathSync(String(p));
    var base = fs.realpathSync(FILES_BASE);
    if (rp === base) return null;
    return rp.indexOf(base + path.sep) === 0 ? rp : null;
  } catch (e) { return null; }
}
function deadLetter(kind, job, err) {
  try {
    fs.appendFileSync(DEAD_LETTER, JSON.stringify({ at: Date.now(), kind: kind, job: job, err: String((err && err.message) || err) }) + String.fromCharCode(10));
  } catch (e) {}
}"""
rep(status_line, helpers, "B helpers")

# C. both queue watchers: replace read+truncate with cursor read (2 hits)
old_read = """      if (!fs.existsSync(qf)) return;
      const lines = fs.readFileSync(qf, "utf8").split("\\n").filter(x => x.trim());
      if (!lines.length) return;
      fs.writeFileSync(qf, "");"""
new_read = """      const lines = readNewLines(qf);
      if (!lines.length) return;"""
n = s.count(old_read)
if n != 2:
    print("!! C cursor : expected 2 hits, got %d" % n)
    sys.exit(2)
s = s.replace(old_read, new_read)
applied.append("C cursor x2")

# D. send queue: path whitelist before any job.path use
rep("""          const job = JSON.parse(line);
          const peer = { chatType: job.chatType, peerUid: job.peerUid, guildId: job.guildId || "" };""",
    """          const job = JSON.parse(line);
          if (job.path !== undefined) {
            const safe = safePath(job.path);
            if (!safe) { deadLetter("send", job, "path outside " + FILES_BASE); log("send job rejected: path outside base", job.path); continue; }
            job.path = safe;
          }
          const peer = { chatType: job.chatType, peerUid: job.peerUid, guildId: job.guildId || "" };""",
    "D path whitelist")

# E. send failure -> dead letter
rep('        } catch (e) { log("send job err", e.message, line); }',
    '        } catch (e) { log("send job err", e.message, line); deadLetter("send", { raw: line }, e); }',
    "E send dead letter")

# F. query failure -> dead letter
rep('        } catch (e) { qlog({ q: "error", error: e.message, line: line }); }',
    '        } catch (e) { qlog({ q: "error", error: e.message, line: line }); deadLetter("query", { raw: line }, e); }',
    "F query dead letter")

io.open(DST, "w", encoding="utf-8").write(s)
print("patched ->", DST)
print("bytes %d -> %d" % (len(orig), len(s)))
for t in applied:
    print("  ok:", t)
