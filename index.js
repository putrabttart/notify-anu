import "dotenv/config";
import { Telegraf } from "telegraf";
import fetch from "node-fetch";
import fs from "fs";

// ================== ENV ==================
const BOT_TOKEN = process.env.BOT_TOKEN;

// PENTING: TANPA GRIVY_BEARER
const GA_CID = process.env.GA_CID;     // dari payload DevTools (gaCid)
const DOMAIN = process.env.DOMAIN;     // dari payload DevTools (domain)

const API_URL =
  process.env.API_URL ||
  "https://us-central1-grivy-barcode.cloudfunctions.net/getCampaign";

const CAMPAIGN_PUBLIC_CODE =
  process.env.CAMPAIGN_PUBLIC_CODE || "frestea-ramadan-911";

const TARGET_URL =
  process.env.TARGET_URL ||
  "https://paduannya-nikmat.frestea.co.id/c/frestea-ramadan-911";

const INTERVAL_MS = Number(process.env.INTERVAL_MS || 90000);

if (!BOT_TOKEN) {
  console.error("ENV BOT_TOKEN belum diisi.");
  process.exit(1);
}
if (!GA_CID) {
  console.error("ENV GA_CID belum diisi. Ambil dari DevTools payload getCampaign (gaCid).");
  process.exit(1);
}
if (!DOMAIN) {
  console.error("ENV DOMAIN belum diisi. Ambil dari DevTools payload getCampaign (domain).");
  process.exit(1);
}

// ================== FILES ==================
const CHAT_FILE = "./chats.json";
const STATE_FILE = "./state.json";

// ================== BOT ==================
const bot = new Telegraf(BOT_TOKEN);

// ---------- Utils: Chats ----------
function loadChats() {
  try {
    const raw = fs.readFileSync(CHAT_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function saveChats(chats) {
  fs.writeFileSync(CHAT_FILE, JSON.stringify(chats, null, 2));
}

// ---------- Utils: State ----------
function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? parsed
      : { lastAvailable: false };
  } catch {
    return { lastAvailable: false };
  }
}
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ---------- Notify helper ----------
async function notifyAll(message) {
  const chats = loadChats();
  if (chats.length === 0) {
    console.log("Belum ada chat terdaftar. Kirim /start ke bot dulu.");
    return;
  }

  for (const c of chats) {
    try {
      await bot.telegram.sendMessage(c.chatId, message);
    } catch (e) {
      console.log("Gagal kirim ke", c.chatId, e?.message || e);
    }
  }
}

// ================== COMMANDS ==================

// /start auto register chatId
bot.start(async (ctx) => {
  const chatId = ctx.chat.id;
  const username = ctx.from.username || ctx.from.first_name || "unknown";
  const type = ctx.chat.type;

  const chats = loadChats();
  const exists = chats.some((c) => c.chatId === chatId);

  if (!exists) {
    chats.push({
      chatId,
      username,
      type,
      registeredAt: new Date().toISOString(),
    });
    saveChats(chats);
    await ctx.reply(
      "✅ Chat kamu berhasil terdaftar.\n" +
      "Aku akan kirim notifikasi kalau voucher tersedia."
    );
  } else {
    await ctx.reply("ℹ️ Chat kamu sudah terdaftar sebelumnya.");
  }
});

// test notif manual
bot.command("testnotif", async (ctx) => {
  await ctx.reply("✅ Oke, kirim test notif...");
  await notifyAll("✅ TEST: Notifikasi bot berhasil terkirim. (uji coba)");
});

// lihat jumlah chat
bot.command("list", async (ctx) => {
  const chats = loadChats();
  await ctx.reply(`Terdaftar: ${chats.length} chat`);
});

// cek status sekarang dari API
bot.command("status", async (ctx) => {
  await ctx.reply("🔍 Ambil status dari API...");
  await checkOnce(true);
  await ctx.reply("✅ Selesai.");
});

// reset state agar notif bisa muncul lagi saat tersedia
bot.command("reset", async (ctx) => {
  const state = loadState();
  state.lastAvailable = false;
  saveState(state);
  await ctx.reply("♻️ State di-reset. Notif akan dikirim lagi kalau berubah TERSEDIA.");
});

// ================== CORE: API CHECK (NO BEARER) ==================

async function fetchCampaign() {
  // payload PERSIS seperti DevTools:
  // {"data":{"publicCode":"frestea-ramadan-911","gaCid":"...","domain":"freshbreak_frestea"}}
  const payload = {
    data: {
      publicCode: CAMPAIGN_PUBLIC_CODE,
      gaCid: String(GA_CID),
      domain: String(DOMAIN),
    },
  };

  // PENTING: tidak ada header Authorization sama sekali
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": "Mozilla/5.0 (VoucherWatcher)",
      origin: "https://paduannya-nikmat.frestea.co.id",
      referer: "https://paduannya-nikmat.frestea.co.id/",
    },
    body: JSON.stringify(payload),
  });

  const txt = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`API error ${res.status} ${res.statusText} :: ${txt.slice(0, 500)}`);
  }

  // parse dari txt biar aman
  return JSON.parse(txt);
}

function parseAvailability(data) {
  const r = data?.result;
  if (!r) {
    return { campaignActive: false, available: false, perStore: [], reason: "no_result" };
  }

  const campaignActive =
    r.campaign_status === "active" &&
    r.expired === false &&
    r.outdated === false;

  const options = r?.campaign_options?.options || [];
  const perStore = options.map((o) => ({
    name: o.options_name,
    available: o.coupons_finished === false, // false = ADA
  }));

  const anyAvailable = perStore.some((s) => s.available);

  return {
    campaignActive,
    available: campaignActive && anyAvailable,
    perStore,
    reason: "ok",
  };
}

function formatStoreLine(perStore) {
  if (!perStore || perStore.length === 0) return "-";
  return perStore.map((s) => `${s.name}=${s.available ? "ADA" : "HABIS"}`).join(" | ");
}

async function checkOnce(manual = false) {
  const state = loadState();

  let json;
  try {
    json = await fetchCampaign();
  } catch (e) {
    const msg = e?.message || String(e);
    console.log("FetchCampaign error:", msg);

    if (manual) {
      await notifyAll(
        `⚠️ Gagal cek API.\n` +
        `Error: ${msg}\n\n` +
        `Catatan:\n` +
        `- Jika 400: GA_CID / DOMAIN / payload tidak cocok.\n` +
        `- Jika 429: terlalu sering cek (naikkan INTERVAL_MS).\n` +
        `- Jika 5xx: server Grivy lagi error (coba lagi).`
      );
    }
    return;
  }

  const info = parseAvailability(json);

  // log ke terminal (penting buat yakin interval jalan)
  console.log(
    `[${new Date().toISOString()}] active=${info.campaignActive} available=${info.available} stores=${formatStoreLine(info.perStore)}`
  );

  // notif hanya saat false -> true
  if (info.available && !state.lastAvailable) {
    const storesAvailable = info.perStore
      .filter((s) => s.available)
      .map((s) => s.name)
      .join(", ");

    await notifyAll(
      `🚨 VOUCHER TERSEDIA!\n` +
      `Toko tersedia: ${storesAvailable}\n` +
      `Link: ${TARGET_URL}`
    );
  }

  state.lastAvailable = info.available;
  state.lastCheck = new Date().toISOString();
  state.lastStores = info.perStore;
  saveState(state);

  if (manual) {
    await notifyAll(
      `📌 STATUS SAAT INI\n` +
      `Campaign aktif: ${info.campaignActive}\n` +
      `Available: ${info.available}\n` +
      `Stores: ${formatStoreLine(info.perStore)}\n` +
      `Last check: ${state.lastCheck}`
    );
  }
}

// ================== RUN ==================
bot.launch().then(() => {
  console.log("Bot running...");
  console.log("Interval:", INTERVAL_MS, "ms");
  console.log("Using Bearer? false"); // biar jelas di log
});

// run langsung + interval
checkOnce(false);
setInterval(() => checkOnce(false), INTERVAL_MS);

// graceful stop
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
