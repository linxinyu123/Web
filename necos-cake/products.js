// products.js - Fetch products (and categories) from Worker API and build window.NECO_DB
(function () {
const API_BASE = "https://necosapi.lestoy.com";
const API_PREFIX = "/necos/v1";
const PRODUCTS_ENDPOINT = `${API_BASE}${API_PREFIX}/products`;


  window.NECO_DB = window.NECO_DB || { categories: [], items: {} };

  function normalizeLangObj(obj, fallbackKey) {
    const o = obj && typeof obj === "object" ? obj : {};
    const fb = (fallbackKey == null) ? "" : String(fallbackKey);
    return {
      en: o.en ?? fb,
      pt: o.pt ?? fb,
      cn: o.cn ?? fb
    };
  }

  async function load() {
    const res = await fetch(PRODUCTS_ENDPOINT, { cache: "no-store" });
    if (!res.ok) throw new Error(`fetch products failed: ${res.status}`);
    const json = await res.json();

    if (!json || json.ok !== true || !json.items) throw new Error("bad products payload");

    // 1) items
    const items = {};
    for (const catId of Object.keys(json.items)) {
      const catKey = String(catId);
      items[catKey] = (json.items[catId] || []).map(p => ({
        id: String(p.id),
        img: (p.images && p.images[0]) ? p.images[0] : (p.img || ""),
        title: normalizeLangObj(p.title, p.id),
        desc: normalizeLangObj(p.description || p.desc, ""),
        variants: (p.variants || []).map(v => ({
          id: String(v.id),
          names: normalizeLangObj(v.name || v.names, v.id),
          price: (typeof v.price_cents === "number") ? (v.price_cents / 100) : (v.price || 0)
        }))
      }));
    }

    // 2) categories
    let categories = [];
    if (Array.isArray(json.categories) && json.categories.length > 0) {
      categories = json.categories.map(c => ({
        id: String(c.id),
        img: c.img || "",
        title: normalizeLangObj(c.title, c.id),
        desc: normalizeLangObj(c.desc, "")
      }));
    } else {
      categories = Object.keys(items).map(catId => {
        const first = (items[catId] && items[catId][0]) ? items[catId][0] : null;
        return {
          id: String(catId),
          img: first ? first.img : "",
          title: normalizeLangObj({ en: catId, pt: catId, cn: catId }, catId),
          desc: normalizeLangObj({ en: "", pt: "", cn: "" }, "")
        };
      });
    }

    window.NECO_DB.categories = categories;
    window.NECO_DB.items = items;
    window.dispatchEvent(new Event("NECO_DB_READY"));
  }

  load().catch(err => {
    console.error("[products.js] load failed:", err);
  });
})();
