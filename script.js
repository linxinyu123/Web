// script.js

const input = document.getElementById('search-input');
const icon  = document.querySelector('.search-icon');

input.addEventListener('input', () => {
    if (input.value.trim() !== '') {
        icon.classList.add('active');
    } else {
        icon.classList.remove('active');
    }
});


// script.js

// 1. 初始化弹窗 HTML (UI 结构)
function initModal() {
    if (!document.getElementById('modal-overlay')) {
        const modalHTML = `
            <div id="modal-overlay">
                <div class="modal-box">
                    <div class="modal-close" onclick="closeModal()">×</div>
                    
                    <!-- 动态内容区 -->
                    <h3 class="modal-title" id="m-title">Aqui está o seu código</h3>
                    <p class="modal-desc">Copie o código abaixo e use-o no checkout.</p>
                    
                    <!-- 复制区域 (如果有码) -->
                    <div id="m-code-container" class="copy-area">
                        <input type="text" id="m-code-input" class="code-text" readonly value="">
                        <button id="m-copy-btn" class="btn-copy-small" onclick="copyModalCode()">Copiar</button>
                    </div>

                    <!-- 无码提示 (如果是直达优惠) -->
                    <div id="m-deal-msg" style="display:none; margin-bottom:20px; color:#27ae60; font-weight:bold; background:#e8f5e9; padding:15px; border-radius:10px;">
                        Desconto aplicado automaticamente!
                    </div>
                    
                    <!-- 底部跳转按钮 -->
                    <a href="#" id="m-go-btn" target="_blank" class="btn-go-store">
                        Ir para a Loja
                    </a>
                </div>
            </div>
        `;
        document.body.insertAdjacentHTML('beforeend', modalHTML);
        
        // 点击遮罩层关闭
        document.getElementById('modal-overlay').addEventListener('click', (e) => {
            if (e.target.id === 'modal-overlay') closeModal();
        });
    }
}

// 2. 打开弹窗 (被 HTML 中的按钮调用)
// 注意：参数 link 就是你的 Affiliate Link
function useCode(code, link) {
    initModal(); // 确保弹窗存在

    const overlay = document.getElementById('modal-overlay');
    const codeInput = document.getElementById('m-code-input');
    const copyBtn = document.getElementById('m-copy-btn');
    const goBtn = document.getElementById('m-go-btn');
    const codeContainer = document.getElementById('m-code-container');
    const dealMsg = document.getElementById('m-deal-msg');

    // 重置按钮文字
    copyBtn.innerText = "Copiar";
    copyBtn.classList.remove('copied');

    // 设置跳转链接
    goBtn.href = link;

    // 判断是有码还是无码
    if (code && code.trim() !== "") {
        // 有码情况
        codeContainer.style.display = "flex";
        dealMsg.style.display = "none";
        codeInput.value = code;
    } else {
        // 无码直达情况
        codeContainer.style.display = "none";
        dealMsg.style.display = "block";
    }

    // 显示弹窗
    overlay.style.display = "flex";
    setTimeout(() => { overlay.classList.add('active'); }, 10);
}

// 3. 弹窗内的复制功能
function copyModalCode() {
    const codeInput = document.getElementById('m-code-input');
    const copyBtn = document.getElementById('m-copy-btn');

    // 选中文本
    codeInput.select();
    codeInput.setSelectionRange(0, 99999); // 适配手机

    // 执行复制
    navigator.clipboard.writeText(codeInput.value).then(() => {
        // 视觉反馈
        copyBtn.innerText = "Copiado!";
        copyBtn.classList.add('copied');
    });
}

// 4. 关闭弹窗
function closeModal() {
    const overlay = document.getElementById('modal-overlay');
    overlay.classList.remove('active');
    setTimeout(() => { overlay.style.display = "none"; }, 300);
}

// ================= 之前的通用逻辑 (加载 Brands) =================
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

        if (container) render(brands);

        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                const term = e.target.value.toLowerCase();
                const filtered = brands.filter(b => b.name.toLowerCase().includes(term));
                render(filtered);
            });
        }
    } catch (error) {}
}

document.addEventListener('DOMContentLoaded', () => {
    loadBrands();
    initModal();
});