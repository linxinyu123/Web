// products.js (NEW) - 从 Worker API 拉取产品数据并构建 NECO_DB
// 目的：不改 index.html / pay.html 的逻辑，仍然让它们读 window.NECO_DB

(function () {
  // ✅ 本地开发时： "http://127.0.0.1:8787"
  // ✅ 线上部署后： "https://api.lestoy.com"（你后面会绑这个）
const API_BASE = "https://necosapi.lestoy.com";
  const PRODUCTS_ENDPOINT = `${API_BASE}/cake-shop/v1/products`;

  // 先给个空的，避免页面脚本抢跑报错
  window.NECO_DB = window.NECO_DB || { categories: [], items: {} };

  // 兜底：如果 API 拉失败，就保留空数据（页面至少不白屏）
  async function load() {
    const res = await fetch(PRODUCTS_ENDPOINT, { cache: "no-store" });
    if (!res.ok) throw new Error(`fetch products failed: ${res.status}`);
    const json = await res.json();

    if (!json || json.ok !== true || !json.items) {
      throw new Error("bad products payload");
    }

    // 1) items：把 API 的字段名转换成你前端需要的字段名
    const items = {};
    for (const catId of Object.keys(json.items)) {
      items[catId] = (json.items[catId] || []).map(p => ({
        id: p.id,
        img: (p.images && p.images[0]) ? p.images[0] : (p.img || ""),
        title: p.title || { en: p.id, cn: p.id, pt: p.id },
        desc: p.description || p.desc || { en: "", cn: "", pt: "" },
        variants: (p.variants || []).map(v => ({
          id: v.id,
          names: v.name || v.names || { en: v.id, cn: v.id, pt: v.id },
          // 你 API 里是 price_cents；老前端是 price(欧元)
          price: (typeof v.price_cents === "number") ? (v.price_cents / 100) : (v.price || 0)
        }))
      }));
    }

    // 2) categories：如果你的 API 还没返回 categories，就先自动生成一个最简版
    // 后面做后台时，我们再把 categories 做成真正可编辑的表
    const categories = Object.keys(items).map(catId => {
      const first = (items[catId] && items[catId][0]) ? items[catId][0] : null;
      return {
        id: catId,
        img: first ? first.img : "",
        title: { en: catId, cn: catId, pt: catId },
        desc: { en: "", cn: "", pt: "" }
      };
    });

  // ✅ 不要整体替换对象！要在原对象上更新字段，保证 index.html 里 const db = NECO_DB 还能拿到最新数据
window.NECO_DB.categories = categories;
window.NECO_DB.items = items;

window.dispatchEvent(new Event("NECO_DB_READY"));

  }

  load().catch(err => {
    console.error("[products.js] load failed:", err);
    // 保底：NECO_DB 仍然存在，页面不至于直接挂
  });
})();
