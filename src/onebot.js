// onebot.js — OneBot v11 子集：HTTP + WebSocket 事件推送（零依赖，可单独测试）
// 只做协议层：所有动作通过 ctx.call.* 转给主进程实现，便于单测与后续拆分。
const http = require("http");
const crypto = require("crypto");


const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function sendJson(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": b.length,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  });
  res.end(b);
}
const ok = (res, data) => sendJson(res, 200, { status: "ok", retcode: 0, data: data === undefined ? null : data });
const fail = (res, retcode, msg) => sendJson(res, 200, { status: "failed", retcode, msg: msg || "", data: null, wording: msg || "" });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on("data", c => { n += c.length; if (n > 8 * 1024 * 1024) { req.destroy(); reject(new Error("body too large")); return; } chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ---------- WebSocket（RFC6455 最小实现：文本帧 / ping / close） ----------
function wsAccept(key) { return crypto.createHash("sha1").update(key + WS_GUID).digest("base64"); }

function encodeFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  const len = body.length;
  let head;
  if (len < 126) { head = Buffer.alloc(2); head[0] = 0x80 | opcode; head[1] = len; }
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, body]);
}

function decodeFrames(buf) {
  const frames = []; let off = 0;
  while (off + 2 <= buf.length) {
    const b0 = buf[off], b1 = buf[off + 1];
    const opcode = b0 & 0x0f, masked = !!(b1 & 0x80);
    let len = b1 & 0x7f, p = off + 2, mask = null;
    if (len === 126) { if (p + 2 > buf.length) break; len = buf.readUInt16BE(p); p += 2; }
    else if (len === 127) { if (p + 8 > buf.length) break; len = Number(buf.readBigUInt64BE(p)); p += 8; }
    if (masked) { if (p + 4 > buf.length) break; mask = buf.slice(p, p + 4); p += 4; }
    if (p + len > buf.length) break;
    const data = Buffer.from(buf.slice(p, p + len));
    if (masked) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
    frames.push({ opcode, payload: data });
    off = p + len;
  }
  return { frames, rest: buf.slice(off) };
}

// ---------- OneBot 消息段 ----------
// 支持：string / [{type,data}]；CQ 码字符串仅解析 text/at/face/image（够用，避免引入正则炸弹）
function parseMessage(msg, autoEscape) {
  if (msg == null) return [];
  if (Array.isArray(msg)) return msg.filter(x => x && x.type);
  const s = String(msg);
  if (autoEscape) return [{ type: "text", data: { text: s } }];
  const segs = [];
  const re = /\[CQ:([a-zA-Z_]+)((?:,[^\]]*)?)\]/g;
  let last = 0, m;
  const pushText = t => { if (t) segs.push({ type: "text", data: { text: t } }); };
  while ((m = re.exec(s))) {
    pushText(s.slice(last, m.index));
    const type = m[1];
    const data = {};
    for (const kv of (m[2] || "").split(",")) {
      if (!kv) continue;
      const i = kv.indexOf("=");
      if (i < 0) continue;
      data[kv.slice(0, i)] = kv.slice(i + 1).replace(/&#44;/g, ",").replace(/&#91;/g, "[").replace(/&#93;/g, "]").replace(/&amp;/g, "&");
    }
    segs.push({ type, data });
    last = m.index + m[0].length;
  }
  pushText(s.slice(last));
  return segs;
}

function actionTable() {
  const A = {};
  const need = (name, fn) => { A[name] = fn; };

  need("get_login_info", async (_p, ctx) => ctx.call.loginInfo());
  need("get_status", async (_p, ctx) => ({ online: true, good: true, self: ctx.call.loginInfo() }));
  need("get_version_info", async () => ({ app_name: "qqours", app_version: "1.0.0", protocol_version: "v11", app_full_name: "qq-ours self-built endpoint" }));
  need("can_send_image", async () => ({ yes: true }));
  need("can_send_record", async () => ({ yes: true }));

  need("send_private_msg", async (p, ctx) => ctx.call.send(1, p.user_id || p.uid, parseMessage(p.message != null ? p.message : p, p.auto_escape), p));
  need("send_group_msg", async (p, ctx) => ctx.call.send(2, p.group_id || p.group, parseMessage(p.message != null ? p.message : p, p.auto_escape), p));
  need("send_msg", async (p, ctx) => {
    const t = String(p.message_type || (p.group_id ? "group" : "private"));
    const chatType = t === "group" ? 2 : 1;
    const peer = t === "group" ? (p.group_id || p.group) : (p.user_id || p.uid);
    return ctx.call.send(chatType, peer, parseMessage(p.message != null ? p.message : p, p.auto_escape), p);
  });

  need("delete_msg", async (p, ctx) => ctx.call.deleteMsg(p.message_id || p.msg_id));
  need("get_msg", async (p, ctx) => ctx.call.getMsg(p.message_id || p.msg_id));
  need("mark_msg_as_read", async (p, ctx) => ctx.call.markRead(p.chat_type || (p.group_id ? 2 : 1), p.group_id || p.user_id));

  need("get_friend_list", async (p, ctx) => ctx.call.friendList(!!p.no_cache));
  need("get_group_list", async (p, ctx) => ctx.call.groupList(!!p.no_cache));
  need("get_group_member_list", async (p, ctx) => ctx.call.groupMemberList(p.group_id || p.group));
  need("get_group_member_info", async (p, ctx) => ctx.call.groupMemberInfo(p.group_id || p.group, p.user_id));
  need("get_group_honor_info", async (p, ctx) => ctx.call.groupHonor(p.group_id || p.group, p.type || "all"));
  need("get_stranger_info", async (p, ctx) => ctx.call.strangerInfo(p.user_id));
  need("get_cookies", async (p, ctx) => ctx.call.cookies(p.domain || "qun.qq.com"));

  need("set_group_kick", async (p, ctx) => ctx.call.groupKick(p.group_id || p.group, p.user_id, !!p.reject_add_request));
  need("set_group_ban", async (p, ctx) => ctx.call.groupBan(p.group_id || p.group, p.user_id, Number(p.duration || 0)));
  need("set_group_whole_ban", async (p, ctx) => ctx.call.groupWholeBan(p.group_id || p.group, p.enable !== false));
  need("set_group_card", async (p, ctx) => ctx.call.groupCard(p.group_id || p.group, p.user_id, p.card || ""));
  need("set_group_admin", async (p, ctx) => ctx.call.groupAdmin(p.group_id || p.group, p.user_id, p.enable !== false));
  need("set_group_leave", async (p, ctx) => ctx.call.groupLeave(p.group_id || p.group));

  need("set_friend_add_request", async (p, ctx) => ctx.call.friendAddRequest(p.flag, p.approve !== false, p.remark || ""));
  need("set_group_add_request", async (p, ctx) => ctx.call.groupAddRequest(p.flag, p.sub_type || p.type || "add", p.approve !== false, p.reason || ""));

  need("send_like", async (p, ctx) => ctx.call.sendLike(p.user_id, Number(p.times || 1)));
  need("get_group_info", async (p, ctx) => ctx.call.groupInfo(p.group_id || p.group));
  need("set_group_name", async (p, ctx) => ctx.call.groupRename(p.group_id || p.group, p.group_name || ""));
  need("delete_group_file", async (p, ctx) => ctx.call.deleteGroupFile(p.group_id || p.group, p.file_id || p.file));
  need("upload_group_file", async (p, ctx) => ctx.call.uploadGroupFile(p.group_id || p.group, p.file, p.name || ""));
  need("add_friend", async (p, ctx) => ctx.call.friendAdd(p.user_id, p.remark || ""));
  need("delete_friend", async (p, ctx) => ctx.call.friendDelete(p.user_id));
  need("set_friend_remark", async (p, ctx) => ctx.call.friendRemark(p.user_id, p.remark || ""));
  need("set_friend_category", async (p, ctx) => ctx.call.friendCategory(p.user_id, p.category_id));
  need("debug_probe", async (p, ctx) => ctx.call.debug_probe(p));
  need("get_recent_contact", async (p, ctx) => ctx.call.recentContact(Number(p.count || 20)));
  return A;
}

const ACTIONS = actionTable();

function makeServer(ctx) {
  const clients = new Set();
  let hbTimer = null;

  const authed = (req, u) => {
    if (!ctx.token) return true;
    const h = String(req.headers["authorization"] || "");
    if (h.toLowerCase().startsWith("bearer ") && h.slice(7).trim() === ctx.token) return true;
    if (u && u.searchParams.get("access_token") === ctx.token) return true;
    return false;
  };

  const push = (event) => {
    if (!clients.size) return;
    let frame;
    try { frame = encodeFrame(1, JSON.stringify(event)); } catch (e) { return; }
    for (const c of clients) { try { c.socket.write(frame); } catch (e) { clients.delete(c); } }
  };

  const server = http.createServer(async (req, res) => {
    let u;
    try { u = new URL(req.url, "http://localhost"); } catch (e) { fail(res, 1400, "bad url"); return; }
    if (req.method === "OPTIONS") { sendJson(res, 204, {}); return; }
    const action = (u.pathname || "/").replace(/^\/+/, "").replace(/\/+$/, "");
    if (action === "health") { ok(res, { online: true, self: ctx.call.loginInfo(), uptime: Math.floor(process.uptime()), ws_clients: clients.size }); return; }
    if (!authed(req, u)) { fail(res, 1403, "access_token 无效"); return; }
    if (action === "") { ok(res, { onebot: "v11-subset", ws: "/?access_token=TOKEN", actions: Object.keys(ACTIONS).length }); return; }
    const fn = ACTIONS[action];
    if (!fn) { fail(res, 1404, "unknown action: " + action); return; }
    let body = {};
    try {
      if (req.method === "POST") {
        const raw = await readBody(req);
        if (raw && raw.trim()) body = JSON.parse(raw);
      }
    } catch (e) { fail(res, 1400, "bad json: " + e.message); return; }
    const params = Object.assign({}, Object.fromEntries(u.searchParams.entries()), body);
    try {
      const data = await fn(params, ctx);
      ok(res, data === undefined ? null : data);
    } catch (e) {
      fail(res, 1500, String((e && e.message) || e));
    }
  });

  server.on("upgrade", (req, socket) => {
    let u;
    try { u = new URL(req.url, "http://localhost"); } catch (e) { socket.destroy(); return; }
    if (!authed(req, u)) { socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); socket.destroy(); return; }
    const key = req.headers["sec-websocket-key"];
    if (!key) { socket.destroy(); return; }
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
      "Sec-WebSocket-Accept: " + wsAccept(key) + "\r\n\r\n"
    );
    const c = { socket, buf: Buffer.alloc(0) };
    clients.add(c);
    socket.on("data", (d) => {
      c.buf = Buffer.concat([c.buf, d]);
      if (c.buf.length > 2 * 1024 * 1024) { clients.delete(c); socket.destroy(); return; }
      const { frames, rest } = decodeFrames(c.buf);
      c.buf = rest;
      for (const f of frames) {
        if (f.opcode === 8) { clients.delete(c); try { socket.end(); } catch (e) {} return; }
        if (f.opcode === 9) { try { socket.write(encodeFrame(10, f.payload)); } catch (e) {} }
      }
    });
    socket.on("close", () => clients.delete(c));
    socket.on("error", () => { clients.delete(c); try { socket.destroy(); } catch (e) {} });
  });

  return {
    server,
    push,
    listen(host, port) {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.removeListener("error", reject);
          if (ctx.heartbeat !== false) {
            hbTimer = setInterval(() => {
              push({ time: Math.floor(Date.now() / 1000), self_id: ctx.call.loginInfo().user_id, post_type: "meta_event", meta_event_type: "heartbeat", interval: 30000, status: { online: true, good: true } });
            }, 30000);
            if (hbTimer.unref) hbTimer.unref();
          }
          resolve();
        });
      });
    },
    close() { try { if (hbTimer) clearInterval(hbTimer); } catch (e) {} try { server.close(); } catch (e) {} },
    clients,
  };
}

module.exports = { makeServer, ACTIONS, parseMessage, encodeFrame, decodeFrames, wsAccept };
