// index.js - Bot de tempo em call de voz
const DISCORD_TOKEN = "process.env.DISCORD_TOKEN";
const ALLOWED_TEXT_CHANNEL = "ranking-de-horas";
const { Client, GatewayIntentBits, Events, ChannelType } = require("discord.js");
const Database = require("better-sqlite3");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const db = new Database("voice_time.db");

// tabelas
db.prepare(`
  CREATE TABLE IF NOT EXISTS sessions (
    user_id TEXT PRIMARY KEY,
    channel_id TEXT,
    join_ts INTEGER
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS totals (
    user_id TEXT PRIMARY KEY,
    total_ms INTEGER DEFAULT 0
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS weekly_totals (
    user_id TEXT,
    week_start INTEGER,
    total_ms INTEGER DEFAULT 0,
    PRIMARY KEY (user_id, week_start)
  )
`).run();

function getWeekStartTs(nowMs) {
  const d = new Date(nowMs);
  const day = d.getUTCDay();
  const diffToMonday = (day + 6) % 7;
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - diffToMonday);
  return d.getTime();
}

function startSession(userId, channelId, ts) {
  db.prepare(
    "INSERT OR REPLACE INTO sessions (user_id, channel_id, join_ts) VALUES (?, ?, ?)"
  ).run(userId, channelId, ts);
}

function endSession(userId, tsNow) {
  const row = db
    .prepare("SELECT user_id, join_ts FROM sessions WHERE user_id = ?")
    .get(userId);
  if (!row) return;

  const elapsed = tsNow - row.join_ts;
  if (elapsed > 0) {
    const existingTotal = db
      .prepare("SELECT total_ms FROM totals WHERE user_id = ?")
      .get(userId);
    if (existingTotal) {
      db.prepare("UPDATE totals SET total_ms = ? WHERE user_id = ?").run(
        existingTotal.total_ms + elapsed,
        userId
      );
    } else {
      db.prepare("INSERT INTO totals (user_id, total_ms) VALUES (?, ?)").run(
        userId,
        elapsed
      );
    }

    const weekStart = getWeekStartTs(tsNow);
    const existingWeekly = db
      .prepare(
        "SELECT total_ms FROM weekly_totals WHERE user_id = ? AND week_start = ?"
      )
      .get(userId, weekStart);

    if (existingWeekly) {
      db.prepare(
        "UPDATE weekly_totals SET total_ms = ? WHERE user_id = ? AND week_start = ?"
      ).run(existingWeekly.total_ms + elapsed, userId, weekStart);
    } else {
      db.prepare(
        "INSERT INTO weekly_totals (user_id, week_start, total_ms) VALUES (?, ?, ?)"
      ).run(userId, weekStart, elapsed);
    }
  }

  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
}

function msToHHMM(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const totalMinutes = Math.floor(totalSeconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const hh = hours.toString().padStart(2, "0");
  const mm = minutes.toString().padStart(2, "0");
  return `${hh}:${mm}`;
}

// ------- helpers -------
function parseHorasMinutos(argHoras, argMinutos) {
  let h = 0, m = 0;
  if (argHoras && argHoras.includes(":")) {
    const [hStr, mStr] = argHoras.split(":");
    h = Number(hStr) || 0;
    m = Number(mStr) || 0;
  } else {
    h = Number(argHoras) || 0;
    m = Number(argMinutos) || 0;
  }
  if (h < 0 || m < 0) return { ms: 0, ok: false };
  const ms = (h * 3600 + m * 60) * 1000;
  return { ms, ok: ms > 0 };
}

function formatHMinFromMs(ms) {
  const minutes = Math.floor(ms / 60000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h > 0 && m > 0) return `${h}h ${m}min`;
  if (h > 0) return `${h}h`;
  return `${m}min`;
}

function chunkMessagesFromLines(lines, header = "") {
  const chunks = [];
  let current = header ? header + "\n" : "";
  for (const line of lines) {
    if ((current + line + "\n").length > 1900) {
      chunks.push(current.trimEnd());
      current = "";
    }
    current += line + "\n";
  }
  if (current.trim().length) chunks.push(current.trimEnd());
  return chunks;
}

function buildRankingGeral() {
  const rows = db
    .prepare("SELECT user_id, total_ms FROM totals WHERE total_ms > 0 ORDER BY total_ms DESC")
    .all();
  if (!rows.length) return ["Ninguém tem tempo registrado ainda."];
  const lines = ["🏆 Ranking geral (tempo total):"];
  rows.forEach((r, i) => lines.push(`${i + 1}. <@${r.user_id}> - ${msToHHMM(r.total_ms)}`));
  return lines;
}

function buildRankingSemanal() {
  const now = Date.now();
  const weekStart = getWeekStartTs(now);
  const rows = db
    .prepare("SELECT user_id, total_ms FROM weekly_totals WHERE week_start = ? AND total_ms > 0 ORDER BY total_ms DESC")
    .all(weekStart);
  if (!rows.length) return ["Essa semana ninguém acumulou tempo ainda."];
  const lines = ["📅 Ranking da semana:"];
  rows.forEach((r, i) => lines.push(`${i + 1}. <@${r.user_id}> - ${msToHHMM(r.total_ms)}`));
  return lines;
}

// controle de voz
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  const userId = newState.id;
  const now = Date.now();

  const oldChannelId = oldState.channelId;
  const newChannelId = newState.channelId;

  if (oldChannelId && !newChannelId) {
    endSession(userId, now);
    return;
  }

  if (!oldChannelId && newChannelId) {
    startSession(userId, newChannelId, now);
    return;
  }

  if (oldChannelId && newChannelId && oldChannelId !== newChannelId) {
    endSession(userId, now);
    startSession(userId, newChannelId, now);
  }
});

// comandos
client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;
  if (msg.channel?.name && msg.channel.name !== ALLOWED_TEXT_CHANNEL) return;
  if (!msg.content.startsWith("!")) return;

  const userId = msg.author.id;

  // !rank — todos, paginado; mantém na tela por ~50s
  if (msg.content.startsWith("!rank")) {
    const geralLines = buildRankingGeral();
    const semanalLines = buildRankingSemanal();

    const header = "⏱ Horas em call de voz\n";
    const corpo = [
      ...geralLines,
      "",
      ...semanalLines,
      "",
      "Obs: Conta só enquanto está conectado. Se o bot cair nesse tempo, não registra."
    ];
    const chunks = chunkMessagesFromLines(corpo, header);

    try {
      await msg.delete().catch(() => {});
      for (const chunk of chunks) {
        const reply = await msg.channel.send(chunk);
        setTimeout(() => reply.delete().catch(() => {}), 50_000); // 50s
      }
    } catch (err) {
      console.error(err);
    }
    return;
  }

  // !meutempo — continua apagando em 5s (se quiser 50s também, avise)
  if (msg.content.startsWith("!meutempo")) {
    const totalRow = db
      .prepare("SELECT total_ms FROM totals WHERE user_id = ?")
      .get(userId);
    let totalMs = totalRow ? totalRow.total_ms : 0;

    const sessRow = db
      .prepare("SELECT join_ts FROM sessions WHERE user_id = ?")
      .get(userId);
    if (sessRow && sessRow.join_ts) {
      const agora = Date.now();
      const elapsed = agora - sessRow.join_ts;
      if (elapsed > 0) totalMs += elapsed;
    }

    const formatted = msToHHMM(totalMs);

    try {
      await msg.delete().catch(() => {});
      const reply = await msg.channel.send(`⏱ <@${userId}>, seu tempo total: **${formatted}**`);
      setTimeout(() => reply.delete().catch(() => {}), 5000);
    } catch (err) {
      console.error(err);
    }
    return;
  }

  // !addtime e !removetime — aceita H M | H:M | H decimal
  if (msg.content.startsWith("!addtime") || msg.content.startsWith("!removetime")) {
    if (msg.author.id !== "352266513652252674") {
      msg.reply("Sem permissão.");
      return;
    }

    const args = msg.content.trim().split(/\s+/);
    const user = msg.mentions.users.first();

    const alvoIndex = 2; // após @user
    const { ms, ok } = parseHorasMinutos(args[alvoIndex], args[alvoIndex + 1]);

    if (!user || !ok) {
      const reply = await msg.reply(
        `Uso: !${msg.content.startsWith("!addtime") ? "addtime" : "removetime"} @usuario <horas minutos>  ou  <horas:minutos>\nEx.: !addtime @fulano 2 30  |  !addtime @fulano 2:30`
      );
      setTimeout(() => reply.delete().catch(() => {}), 8000);
      return;
    }

    const operacao = msg.content.startsWith("!addtime") ? 1 : -1;
    const now = Date.now();
    const weekStart = getWeekStartTs(now);

    // total geral
    const totalRow = db.prepare("SELECT total_ms FROM totals WHERE user_id = ?").get(user.id);
    if (!totalRow) {
      if (operacao === -1) {
        const reply = await msg.reply("Usuário não encontrado no banco para remover tempo.");
        setTimeout(() => reply.delete().catch(() => {}), 6000);
        return;
      }
      db.prepare("INSERT INTO totals (user_id, total_ms) VALUES (?, ?)").run(user.id, ms);
    } else {
      const novoTotal = Math.max(0, totalRow.total_ms + operacao * ms);
      db.prepare("UPDATE totals SET total_ms = ? WHERE user_id = ?").run(novoTotal, user.id);
    }

    // semanal
    const weekRow = db
      .prepare("SELECT total_ms FROM weekly_totals WHERE user_id = ? AND week_start = ?")
      .get(user.id, weekStart);

    if (weekRow) {
      const novoSemanal = Math.max(0, weekRow.total_ms + operacao * ms);
      db.prepare("UPDATE weekly_totals SET total_ms = ? WHERE user_id = ? AND week_start = ?")
        .run(novoSemanal, user.id, weekStart);
    } else if (operacao === 1) {
      db.prepare("INSERT INTO weekly_totals (user_id, week_start, total_ms) VALUES (?, ?, ?)")
        .run(user.id, weekStart, ms);
    }

    const qtdFmt = formatHMinFromMs(ms);
    const acao = operacao === 1 ? "adicionados" : "removidos";
    const reply = await msg.reply(`${qtdFmt} ${acao} para ${user.username}.`);
    setTimeout(() => reply.delete().catch(() => {}), 10000);
    return;
  }
});

// limpeza automática (só mensagens de usuário; mantém as do bot)
client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;
  if (msg.channel?.name !== ALLOWED_TEXT_CHANNEL) return;

  const pinned = await msg.channel.messages.fetchPinned();
  if (pinned.has(msg.id)) return;

  setTimeout(() => {
    msg.delete().catch(() => {});
  }, 5000);
});

client.on(Events.ClientReady, () => {
  console.log(`Bot logado como ${client.user.tag}`);
  // Sem auto-post de ranking. Só manual via !rank.
});

client.on("error", console.error);
process.on("unhandledRejection", console.error);

client.login(DISCORD_TOKEN);
