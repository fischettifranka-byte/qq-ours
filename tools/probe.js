const m = { exports: {} };
try {
  process.dlopen(m, "/opt/QQ/resources/app/wrapper.node");
  console.log("DLOPEN_OK exports:", Object.keys(m.exports).join(", "));
} catch (e) {
  console.log("DLOPEN_FAIL:", e.message.split("\n")[0]);
}
