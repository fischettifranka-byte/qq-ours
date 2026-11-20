function tryLoad(p, tag) {
  const m = { exports: {} };
  try { process.dlopen(m, p); console.log(tag, "OK:", Object.keys(m.exports).slice(0,12).join(", ")); return m.exports; }
  catch (e) { console.log(tag, "FAIL:", e.message.split("\n")[0]); return null; }
}
tryLoad("/opt/QQ/resources/app/major.node", "MAJOR");
tryLoad("/opt/QQ/resources/app/wrapper.node", "WRAPPER");
