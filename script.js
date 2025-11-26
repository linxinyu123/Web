// script.js

// 1. 首页：加载品牌列表
async function loadBrands() {
    try {
        const response = await fetch('brands.json');
        const brands = await response.json();
        const container = document.getElementById('brands-container');
        const searchInput = document.getElementById('search-input');

        function render(items) {
            container.innerHTML = items.map(brand => `
                <a href="${brand.url}" class="brand-card">
                    <img src="${brand.logo}" alt="${brand.name}" loading="lazy">
                    <span>${brand.name}</span>
                </a>
            `).join('');
        }

        render(brands);

        // 搜索功能
        searchInput.addEventListener('input', (e) => {
            const term = e.target.value.toLowerCase();
            const filtered = brands.filter(b => b.name.toLowerCase().includes(term));
            render(filtered);
        });

    } catch (error) {
        console.log("Not on homepage or error loading JSON");
    }
}

// 2. 详情页：复制并跳转 (Affiliate 核心)
function useCode(code, link) {
    // A. 复制到剪贴板
    if (code) {
        navigator.clipboard.writeText(code).then(() => {
            alert(`Código "${code}" copiado! A abrir a loja...`);
        }).catch(() => {
            alert(`O seu código é: ${code}`);
        });
    } else {
        // 如果没有码（仅直达优惠）
        // alert("Oferta ativada! A abrir a loja...");
    }

    // B. 打开联盟链接 (新窗口)
    setTimeout(() => {
        window.open(link, '_blank');
    }, 500);
}

// 自动检测运行
if (document.getElementById('brands-container')) {
    loadBrands();
}
