// <--- GANTI_DENGAN_URL_WEB_APP_GOOGLE_ANDA_DISINI --->
const API_URL = "https://script.google.com/macros/s/AKfycbzLrATvow-JwSCZBQeHpb2vUV431kXl6JsgXu63TkoodlqdEZ3p_o6a20F9rT3zPBYk/exec"; 
// ^^^ JANGAN LUPA UBAH BARIS 2 INI ^^^

const DB_NAME = "Buffet_POS_DB";
const DB_VERSION = 25; 
let db;

let currentCategory = ""; 
let currentSubCategory = "All"; 
let globalMenuData = [];

let tablePrefix = "A"; 
let activeOrders = []; 
let currentOrderIndex = 0; 
let activePlateIndex = 0; 
let taxRatePercent = 0;   
let currentCashier = "";
let currentPin = "";
let currentShiftId = "";
let currentLoginTime = "";
let nextTableNumber = 1; 
let currentVoidTarget = { type: null, id: null };
window.masterDrawerBalance = 0; 
window.currentReviewTotals = { baseSubtotal: 0, effectiveSubtotal: 0, totalSavings: 0, promoDiscount: 0, promoName: "", taxAmount: 0, grandTotal: 0 };
window.currentShiftData = {}; 
let isLoggingOut = false; 

// ---------------------------------------------------------
// PWA INSTALL PROMPT
// ---------------------------------------------------------
let deferredPrompt;
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); 
    deferredPrompt = e;
    const loginBtn = document.getElementById('top-install-btn');
    const workspaceBtn = document.getElementById('workspace-install-btn');
    if (loginBtn) loginBtn.classList.remove('hidden');
    if (workspaceBtn) workspaceBtn.classList.remove('hidden');
});

async function handleInstallClick() {
    if (deferredPrompt) { 
        deferredPrompt.prompt(); 
        const { outcome } = await deferredPrompt.userChoice; 
        if (outcome === 'accepted') { 
            document.getElementById('top-install-btn')?.classList.add('hidden'); 
            document.getElementById('workspace-install-btn')?.classList.add('hidden'); 
        } 
        deferredPrompt = null; 
    }
}
document.getElementById('top-install-btn')?.addEventListener('click', handleInstallClick);
document.getElementById('workspace-install-btn')?.addEventListener('click', handleInstallClick);

// ---------------------------------------------------------
// DATABASE INITIALIZATION 
// ---------------------------------------------------------
function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = (event) => {
            db = event.target.result;
            
            const dbStores = {
                "staff": "pin", "menu": "itemId", "settings": "key", "orders": "orderId", "expenses": "expenseId",
                "members": "phone", "unsynced_members": "phone", "expense_categories": "name", "void_requests": "id",
                "promo_codes": "code", "shift_reports": "shiftId", "past_shifts": "shiftId", "active_shifts": "pin",
                "cash_drops": "dropId", "local_shift_history": "shiftId"
            };

            Object.keys(dbStores).forEach(storeName => {
                if (db.objectStoreNames.contains(storeName)) { db.deleteObjectStore(storeName); }
                db.createObjectStore(storeName, { keyPath: dbStores[storeName] });
            });
        };
        request.onsuccess = (event) => { db = event.target.result; resolve(db); };
        request.onerror = (event) => { reject(event.target.errorCode); };
    });
}

function preserveUnpaidTables() {
    if (!currentShiftId) return;
    const cacheState = { activeOrders: activeOrders, nextTableNumber: nextTableNumber, currentOrderIndex: currentOrderIndex, activePlateIndex: activePlateIndex };
    localStorage.setItem(`unpaid_cache_${currentShiftId}`, JSON.stringify(cacheState));
}
function restoreUnpaidTables() {
    const recovered = localStorage.getItem(`unpaid_cache_${currentShiftId}`);
    if (recovered) {
        const parsed = JSON.parse(recovered);
        activeOrders = parsed.activeOrders || []; nextTableNumber = parsed.nextTableNumber || 1;
        currentOrderIndex = parsed.currentOrderIndex || 0; activePlateIndex = parsed.activePlateIndex || 0;
    } else { activeOrders = []; nextTableNumber = 1; }
}

// ---------------------------------------------------------
// LOGIN & SESSION MANAGEMENT 
// ---------------------------------------------------------
function attemptLogin() {
    const pinInput = String(document.getElementById("cashier-pin").value).trim();
    if (!pinInput) return alert("Harap masukkan PIN");

    try {
        db.transaction(["staff"], "readonly").objectStore("staff").getAll().onsuccess = (e) => {
            const staffList = e.target.result;
            const staffMember = staffList.find(s => String(s.pin).trim() === pinInput);

            if (staffMember) {
                db.transaction(["active_shifts"], "readwrite").objectStore("active_shifts").get(staffMember.pin).onsuccess = (shiftRes) => {
                    let sessionData;
                    if (shiftRes.target.result) {
                        sessionData = { name: staffMember.name, pin: staffMember.pin, shiftId: shiftRes.target.result.shiftId, loginTime: shiftRes.target.result.loginTime };
                    } else {
                        sessionData = { name: staffMember.name, pin: staffMember.pin, shiftId: "SHF-" + Date.now(), loginTime: new Date().toISOString() };
                        db.transaction(["active_shifts"], "readwrite").objectStore("active_shifts").put({ pin: staffMember.pin, shiftId: sessionData.shiftId, loginTime: sessionData.loginTime });
                    }
                    localStorage.setItem("pos_active_session", JSON.stringify(sessionData));
                    loadSessionData(sessionData);
                };
            } else { 
                let memoryDump = staffList.map(s => `[${s.pin}] - ${s.name}`).join("\n");
                if (!memoryDump) memoryDump = "KOSONG! Data belum terunduh.";
                alert(`PIN "${pinInput}" gagal.\n\nMemori tablet saat ini berisi:\n---------------------\n${memoryDump}\n---------------------\nJika memori kosong, klik Sinkronisasi Database!`); 
                document.getElementById("cashier-pin").value = ""; 
            }
        };
    } catch(err) {
        alert("Database belum siap. Harap klik Sinkronisasi Database.");
    }
}

document.addEventListener("DOMContentLoaded", () => {
    const pinField = document.getElementById("cashier-pin");
    if(pinField) {
        pinField.addEventListener("keypress", function(event) {
            if (event.key === "Enter") {
                event.preventDefault();
                attemptLogin();
            }
        });
    }
});

function checkActiveSession() {
    const savedSession = localStorage.getItem("pos_active_session");
    if (savedSession) { loadSessionData(JSON.parse(savedSession)); }
}
function loadSessionData(session) {
    currentCashier = session.name; currentPin = session.pin; currentShiftId = session.shiftId; currentLoginTime = session.loginTime;
    document.getElementById("login-screen").classList.add("hidden"); document.getElementById("pos-screen").classList.remove("hidden");
    document.getElementById("display-cashier").innerText = currentCashier; document.getElementById("cashier-pin").value = "";
    document.getElementById("shift-login-indicator").innerText = `Waktu Masuk: ${new Date(currentLoginTime).toLocaleTimeString('id-ID')}`;
    
    restoreUnpaidTables(); loadMenuUI(); initTabs(); 
}
function lockScreen() { localStorage.removeItem("pos_active_session"); window.location.reload(); }

// ---------------------------------------------------------
// SILENT MASTER DATA SYNC (AUTO-PULL)
// ---------------------------------------------------------
async function loginScreenSync() {
    const btn = document.getElementById("login-sync-btn");
    btn.disabled = true;
    await syncMasterData(false); 
    btn.disabled = false;
}

async function syncDataStore(storeName, dataArray) {
    if (!dataArray || dataArray.length === 0) return;
    return new Promise((resolve) => {
        const tx = db.transaction([storeName], "readwrite");
        const store = tx.objectStore(storeName);
        store.clear();
        dataArray.forEach(item => {
            try { store.put(item); } catch(err) { console.warn(`Data korup dilewati di ${storeName}:`, item); }
        });
        tx.oncomplete = () => resolve(true);
        tx.onerror = (e) => { console.error(`Gagal sinkron ${storeName}`, e); resolve(false); };
    });
}

async function syncMasterData(isSilent = false) {
    const statusText = document.getElementById("network-text");
    const loginStatus = document.getElementById("login-sync-status");
    const loginBtn = document.querySelector("#login-screen button");
    
    if (!navigator.onLine) { 
        if(statusText) statusText.innerText = "Mode Offline"; 
        if(!isSilent && loginStatus) loginStatus.innerText = "Status: Mode Offline ❌"; 
        const dot = document.getElementById("network-dot"); if(dot) dot.style.backgroundColor = "#e74c3c"; 
        return; 
    }
    
    if(!isSilent) {
        if(statusText) statusText.innerText = "Menyinkronkan...";
        if(loginStatus) loginStatus.innerText = "Status: Menyinkronkan... ⏳"; 
        if(loginBtn) loginBtn.disabled = true;
    }
    
    try {
        const response = await fetch(API_URL); 
        const text = await response.text();
        if (text.includes("<!DOCTYPE html>")) throw new Error("Akses ditolak oleh Google. Harap buka URL Script di browser baru untuk login.");
        
        const result = JSON.parse(text);
        if (result.status === "Success") {
            window.masterDrawerBalance = result.masterDrawerBalance || 0; 
            
            await syncDataStore("staff", result.data.staff);
            await syncDataStore("menu", result.data.menu);
            await syncDataStore("members", result.data.members);
            await syncDataStore("promo_codes", result.data.promoCodes);
            await syncDataStore("past_shifts", result.data.pastShifts);
            
            let settingsArr = [];
            if(result.data.settings) for (const [key, value] of Object.entries(result.data.settings)) { settingsArr.push({ key: key, value: value }); }
            await syncDataStore("settings", settingsArr);
            
            let catArr = [];
            if (result.data.expenseCategories) result.data.expenseCategories.forEach(cat => catArr.push({ name: cat }));
            await syncDataStore("expense_categories", catArr);

            if (result.data.authStatuses) processVoidApprovals(result.data.authStatuses);
            
            globalMenuData = result.data.menu || [];
            if(!document.getElementById("pos-screen").classList.contains("hidden")) { renderProductGrid(); }

            if(statusText) statusText.innerText = "Online & Sinkron"; 
            if(!isSilent && loginStatus) loginStatus.innerText = "Status: Database Tersinkron ✅"; 
            loadSettingsForCart();
        }
    } catch (error) { 
        if(!isSilent) alert("Error Sinkronisasi: " + error.message);
        if(statusText) statusText.innerText = "Online (Lokal)"; 
        if(!isSilent && loginStatus) loginStatus.innerText = "Status: Sinkronisasi Gagal ⚠️"; 
        const dot = document.getElementById("network-dot"); if(dot) dot.style.backgroundColor = "#f39c12"; 
    } finally {
        if(!isSilent && loginBtn) loginBtn.disabled = false;
    }
}

// ---------------------------------------------------------
// DECENTRALIZED VOID AFTERMATH ENGINE (WITH DRAWER REFUND)
// ---------------------------------------------------------
function processVoidApprovals(authStatuses) {
    const tx = db.transaction(["orders", "expenses"], "readwrite");
    const ordStore = tx.objectStore("orders"); const expStore = tx.objectStore("expenses");
    let uiNeedsRefresh = false;

    ordStore.getAll().onsuccess = (e) => {
        e.target.result.forEach(order => {
            const remote = authStatuses.orders[order.orderId];
            if (remote) {
                if (remote.status === "Voided" && order.orderStatus !== "Voided") {
                    order.orderStatus = "Voided"; ordStore.put(order); uiNeedsRefresh = true;
                    applyVoidAftermath(order); 
                } else if (remote.status !== "Void Pending" && remote.status !== "Voided" && order.orderStatus === "Void Pending") {
                    order.orderStatus = remote.status; ordStore.put(order); uiNeedsRefresh = true;
                }
            }
        });
        if (uiNeedsRefresh && !document.getElementById("history-modal").classList.contains("hidden")) renderHistoryList('orders');
    };

    expStore.getAll().onsuccess = (e) => {
        e.target.result.forEach(exp => {
            const remote = authStatuses.expenses[exp.expenseId];
            if (remote) {
                if (remote.status === "Voided" && exp.status !== "Voided") {
                    exp.status = "Voided"; expStore.put(exp); uiNeedsRefresh = true;
                    applyVoidAftermathExpense(exp); 
                } else if (remote.status !== "Void Pending" && remote.status !== "Voided" && exp.status === "Void Pending") {
                    exp.status = remote.status; expStore.put(exp); uiNeedsRefresh = true;
                }
            }
        });
        if (uiNeedsRefresh && !document.getElementById("history-modal").classList.contains("hidden")) renderHistoryList('expenses');
    };
}

function applyVoidAftermath(order) {
    let itemsToReturn = [];
    order.plates.forEach(p => p.items.forEach(i => itemsToReturn.push({ name: i.name, qty: i.qty })));
    
    const tx = db.transaction(["menu", "members"], "readwrite");
    const menuStore = tx.objectStore("menu"); const memberStore = tx.objectStore("members");

    itemsToReturn.forEach(item => {
        menuStore.openCursor().onsuccess = (e) => {
            const cursor = e.target.result;
            if (cursor) {
                if (cursor.value.name === item.name && cursor.value.trackStock) { const updated = cursor.value; updated.currentStock += item.qty; cursor.update(updated); }
                cursor.continue();
            }
        };
    });
    tx.oncomplete = () => { if(!document.getElementById("pos-screen").classList.contains("hidden")) renderProductGrid(); };

    if (order.customerPhone && order.customerPhone !== "Walk-in" && order.customerPhone !== "-") {
        memberStore.get(order.customerPhone).onsuccess = (e) => {
            const mem = e.target.result;
            if (mem) { mem.spent = Math.max(0, (mem.spent || 0) - order.grandTotal); memberStore.put(mem); }
        };
    }

    if (navigator.onLine) {
        fetch(API_URL, { method: "POST", body: JSON.stringify({ action: "executeVoidAftermath", data: { orderId: order.orderId, customerPhone: order.customerPhone, amount: order.grandTotal, cashAmount: order.cashAmount || 0, itemsToReturn: itemsToReturn } }) }).catch(e => console.log(e));
    }
}

function applyVoidAftermathExpense(exp) {
    if (navigator.onLine) {
        fetch(API_URL, { method: "POST", body: JSON.stringify({ action: "executeVoidAftermathExpense", data: { amount: exp.amount } }) }).catch(e => console.log(e));
    }
}

// ---------------------------------------------------------
// MENU & PRODUCT UI
// ---------------------------------------------------------
function loadMenuUI() {
    const store = db.transaction(["menu"], "readonly").objectStore("menu");
    store.getAll().onsuccess = (e) => {
        globalMenuData = e.target.result || [];
        if (globalMenuData.length === 0) {
            document.getElementById("product-grid").innerHTML = "<div style='padding:20px;'>Menu kosong. Silakan isi Menu_Master di Google Sheets.</div>";
            return;
        }
        
        const categories = [...new Set(globalMenuData.map(item => item.category))].filter(Boolean);
        if(categories.length > 0) {
            currentCategory = categories[0]; 
        } else {
            currentCategory = "Uncategorized";
        }

        const tabsContainer = document.getElementById("category-container"); tabsContainer.innerHTML = ""; 
        categories.forEach((cat) => {
            const btn = document.createElement("button"); btn.className = `cat-btn ${cat === currentCategory ? "active" : ""}`; btn.innerText = cat;
            btn.onclick = () => {
                currentCategory = cat; currentSubCategory = "All"; document.getElementById("search-input").value = ""; 
                document.querySelectorAll(".cat-btn").forEach(b => b.classList.remove("active")); btn.classList.add("active");
                renderSubCategories(); renderProductGrid();
            };
            tabsContainer.appendChild(btn);
        });
        renderSubCategories(); renderProductGrid();
    };
}
function renderSubCategories() {
    const subTabsContainer = document.getElementById("sub-category-container"); subTabsContainer.innerHTML = "";
    const categoryItems = globalMenuData.filter(item => item.category === currentCategory);
    const subCats = [...new Set(categoryItems.map(item => item.subCategory))].filter(Boolean);
    if (subCats.length <= 1) { subTabsContainer.style.display = "none"; return; }
    subTabsContainer.style.display = "flex"; subCats.unshift("All"); 

    subCats.forEach(sub => {
        const btn = document.createElement("button"); btn.className = `sub-cat-btn ${sub === currentSubCategory ? "active" : ""}`; btn.innerText = sub;
        btn.onclick = () => {
            currentSubCategory = sub; document.querySelectorAll(".sub-cat-btn").forEach(b => b.classList.remove("active"));
            btn.classList.add("active"); renderProductGrid();
        };
        subTabsContainer.appendChild(btn);
    });
}
function filterMenuBySearch() { renderProductGrid(); }
function renderProductGrid() {
    const grid = document.getElementById("product-grid"); grid.innerHTML = ""; 
    const searchQuery = document.getElementById("search-input").value.toLowerCase();

    const filteredItems = globalMenuData.filter(item => {
        const matchesCategory = item.category === currentCategory;
        const matchesSubCat = currentSubCategory === "All" ? true : item.subCategory === currentSubCategory;
        const matchesSearch = item.name.toLowerCase().includes(searchQuery);
        return matchesCategory && matchesSubCat && matchesSearch;
    }).sort((a, b) => a.name.localeCompare(b.name));

    filteredItems.forEach(item => {
        const card = document.createElement("div"); card.className = "product-card";
        const fullPrice = Number(item.price) || 0; const halfPrice = Number(item.halfPrice) || 0;
        const itemDiscountPercent = item.specificDiscount || 0;
        const isOutOfStock = item.trackStock && item.currentStock <= 0;

        const infoDiv = document.createElement("div"); infoDiv.className = "product-info";
        if (isOutOfStock) infoDiv.style.opacity = "0.5";
        
        const title = document.createElement("h4"); title.style.margin = "0 0 5px 0"; title.style.fontSize = "15px"; title.innerText = item.name; infoDiv.appendChild(title);
        const priceP = document.createElement("p"); priceP.style.margin = "0"; priceP.style.fontSize = "14px"; priceP.style.color = "#7f8c8d";
        
        if (halfPrice > 0) {
            let calcHalf = halfPrice - (halfPrice * (itemDiscountPercent / 100));
            let calcFull = fullPrice - (fullPrice * (itemDiscountPercent / 100));
            if (itemDiscountPercent > 0) {
                priceP.innerHTML = `<small>½</small> <del style="font-size:11px;">Rp ${halfPrice.toLocaleString('id-ID')}</del> <strong style="color:#e74c3c;">Rp ${calcHalf.toLocaleString('id-ID')}</strong><br>
                                    <small>1</small> <del style="font-size:11px;">Rp ${fullPrice.toLocaleString('id-ID')}</del> <strong style="color:#e74c3c;">Rp ${calcFull.toLocaleString('id-ID')}</strong><br>
                                    <span style="background:#e74c3c; color:white; padding:2px 4px; border-radius:4px; font-size:10px; display:inline-block; margin-top:4px;">-${itemDiscountPercent}% OFF</span>`;
            } else { priceP.innerHTML = `<small>½</small> Rp ${halfPrice.toLocaleString('id-ID')}<br><small>1</small> Rp ${fullPrice.toLocaleString('id-ID')}`; }
        } else {
            let calcFull = fullPrice - (fullPrice * (itemDiscountPercent / 100));
            if (itemDiscountPercent > 0) {
                priceP.innerHTML = `<del style="font-size:11px;">Rp ${fullPrice.toLocaleString('id-ID')}</del><br><strong style="color:#e74c3c; font-size:16px;">Rp ${calcFull.toLocaleString('id-ID')}</strong><br>
                                    <span style="background:#e74c3c; color:white; padding:2px 4px; border-radius:4px; font-size:10px; display:inline-block; margin-top:4px;">-${itemDiscountPercent}% OFF</span>`;
            } else { priceP.innerText = `Rp ${fullPrice.toLocaleString('id-ID')}`; }
        }
        infoDiv.appendChild(priceP);
        
        if (item.trackStock) {
            const stockP = document.createElement("p"); stockP.style.margin = "5px 0 0 0"; stockP.style.fontSize = "12px"; stockP.style.fontWeight = "bold";
            stockP.style.color = isOutOfStock ? "#e74c3c" : "#2980b9"; stockP.innerText = `Stok: ${item.currentStock}`; infoDiv.appendChild(stockP);
        }
        card.appendChild(infoDiv);

        const actionsDiv = document.createElement("div"); actionsDiv.className = "product-actions";
        if (isOutOfStock) {
            const btnOut = document.createElement("button"); btnOut.className = "btn-add"; btnOut.innerText = "Stok Habis";
            btnOut.style.backgroundColor = "#e74c3c"; btnOut.style.color = "white"; btnOut.style.cursor = "not-allowed"; btnOut.disabled = true; actionsDiv.appendChild(btnOut);
        } else if (halfPrice > 0) {
            const btnHalf = document.createElement("button"); btnHalf.className = "btn-add"; btnHalf.innerText = "½"; btnHalf.onclick = () => addItemToCart(item, 0.5, halfPrice);
            const btnFull = document.createElement("button"); btnFull.className = "btn-add"; btnFull.innerText = "1"; btnFull.onclick = () => addItemToCart(item, 1, fullPrice);
            actionsDiv.appendChild(btnHalf); actionsDiv.appendChild(btnFull);
        } else {
            const btnAdd = document.createElement("button"); btnAdd.className = "btn-add"; btnAdd.innerText = "+ Tambah"; btnAdd.onclick = () => addItemToCart(item, 1, fullPrice);
            actionsDiv.appendChild(btnAdd);
        }
        card.appendChild(actionsDiv); grid.appendChild(card);
    });
}

// ---------------------------------------------------------
// CART & CHECKOUT ENGINE
// ---------------------------------------------------------
function initTabs() { renderCustomerTabs(); renderCartUI(); }
function renderCustomerTabs() {
    const container = document.getElementById("customer-tabs"); container.innerHTML = "";
    activeOrders.forEach((order, index) => {
        const btn = document.createElement("button"); btn.className = `cust-tab ${index === currentOrderIndex ? "active" : ""}`;
        btn.innerText = order.customerName && order.customerName !== "Walk-in" ? `${order.name} (${order.customerName})` : order.name;
        btn.onclick = () => { currentOrderIndex = index; activePlateIndex = 0; renderCustomerTabs(); renderCartUI(); };
        container.appendChild(btn);
    });
    const addBtn = document.createElement("button"); addBtn.className = "cust-tab"; addBtn.innerText = "+ Tambah Meja"; addBtn.onclick = openAddTableModal;
    container.appendChild(addBtn);
}
function openAddTableModal() {
    document.getElementById("add-table-modal").classList.remove("hidden");
    document.getElementById("cust-phone").value = ""; document.getElementById("cust-name").value = "";
    const list = document.getElementById("member-list"); list.innerHTML = "";
    db.transaction(["members"], "readonly").objectStore("members").getAll().onsuccess = (e) => {
        e.target.result.forEach(member => { const opt = document.createElement("option"); opt.value = member.phone; opt.innerText = member.name; list.appendChild(opt); });
    };
}
document.getElementById("cust-phone").addEventListener("input", (e) => {
    db.transaction(["members"], "readonly").objectStore("members").get(e.target.value).onsuccess = (res) => {
        if(res.target.result) document.getElementById("cust-name").value = res.target.result.name;
    };
});
function closeAddTableModal() { document.getElementById("add-table-modal").classList.add("hidden"); }
function confirmAddTable() {
    const phone = document.getElementById("cust-phone").value.trim();
    const name = document.getElementById("cust-name").value.trim() || "Walk-in";
    if (phone) {
        const memberData = { phone: phone, name: name };
        db.transaction(["members"], "readwrite").objectStore("members").put(memberData);
        db.transaction(["unsynced_members"], "readwrite").objectStore("unsynced_members").put(memberData);
    }
    activeOrders.push({ name: `Meja ${tablePrefix}${nextTableNumber}`, customerName: name, customerPhone: phone || "Walk-in", plates: [{ plateId: 1, items: [] }] });
    nextTableNumber++; currentOrderIndex = activeOrders.length - 1; activePlateIndex = 0;
    preserveUnpaidTables(); closeAddTableModal(); renderCustomerTabs(); renderCartUI(); runBackgroundSync();
}
function loadSettingsForCart() {
    db.transaction(["settings"], "readonly").objectStore("settings").get("Tax_Rate_Percent").onsuccess = (e) => {
        if (e.target.result && e.target.result.value) taxRatePercent = parseFloat(e.target.result.value);
    };
}
function addItemToCart(item, portionType, basePrice) {
    if (activeOrders.length === 0) return alert("Harap buka meja terlebih dahulu dengan mengklik '+ Tambah Meja'!");
    let effectivePrice = basePrice;
    if (item.specificDiscount > 0) effectivePrice = basePrice - (basePrice * (item.specificDiscount / 100));

    const activePlate = activeOrders[currentOrderIndex].plates[activePlateIndex];
    const existingItem = activePlate.items.find(i => i.itemId === item.itemId && i.portionType === portionType);
    
    if (existingItem) { existingItem.qty += 1; } else {
        activePlate.items.push({ 
            itemId: item.itemId, name: portionType === 0.5 ? `${item.name} (½)` : item.name, 
            portionType: portionType, originalPrice: basePrice, price: effectivePrice, qty: 1,
            isDiscountable: item.isDiscountable, hasSpecificDiscount: item.specificDiscount > 0 
        });
    }
    preserveUnpaidTables(); renderCartUI();
}
function updateQty(plateIndex, itemIndex, delta) {
    const item = activeOrders[currentOrderIndex].plates[plateIndex].items[itemIndex];
    item.qty += delta;
    if (item.qty <= 0) activeOrders[currentOrderIndex].plates[plateIndex].items.splice(itemIndex, 1);
    preserveUnpaidTables(); renderCartUI();
}
function renderCartUI() {
    const container = document.getElementById("plates-container"); container.innerHTML = ""; 
    if (activeOrders.length === 0) {
        container.innerHTML = `<div style="text-align:center; padding:40px; color:#bdc3c7; font-size:16px;">Belum ada meja aktif.</div>`;
        document.getElementById("cart-subtotal").innerText = "Rp 0"; document.getElementById("cart-tax").innerText = "Rp 0"; document.getElementById("cart-total").innerText = "Rp 0";
        return;
    }
    let subtotal = 0; const currentOrder = activeOrders[currentOrderIndex];
    currentOrder.plates.forEach((plate, index) => {
        const plateBox = document.createElement("div"); plateBox.className = "plate-box";
        if (index === activePlateIndex) { plateBox.style.borderColor = "#3498db"; plateBox.style.borderWidth = "2px"; plateBox.style.background = "#f4fbff"; }
        
        let itemsHtml = "";
        if (plate.items.length === 0) itemsHtml = `<div style="color:#bdc3c7; font-size:14px; text-align:center; margin-top:10px;">Keranjang kosong</div>`;
        else {
            plate.items.forEach((cartItem, itemIndex) => {
                const itemTotal = cartItem.price * cartItem.qty; subtotal += itemTotal;
                itemsHtml += `
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 8px; font-size: 14px; border-bottom: 1px dashed #eee; padding-bottom: 8px;">
                        <div style="display: flex; align-items: center; gap: 10px;">
                            <span style="font-weight: 500;">${cartItem.name}</span>
                            <div style="display: flex; align-items: center; gap: 4px;">
                                <button class="qty-btn" style="width:24px; height:24px; font-size:14px;" onclick="updateQty(${index}, ${itemIndex}, -1)">-</button>
                                <span style="font-weight:bold; width:18px; text-align:center;">${cartItem.qty}</span>
                                <button class="qty-btn" style="width:24px; height:24px; font-size:14px;" onclick="updateQty(${index}, ${itemIndex}, 1)">+</button>
                            </div>
                        </div>
                        <span style="font-weight: bold; color: #2c3e50;">Rp ${itemTotal.toLocaleString('id-ID')}</span>
                    </div>`;
            });
        }
        plateBox.innerHTML = `<div class="plate-header"><span>Piring ${plate.plateId} ${index === activePlateIndex ? '🟢' : ''}</span><button class="btn-new-plate" onclick="addNewPlate()">+ Piring Baru</button></div>${itemsHtml}`;
        plateBox.onclick = (e) => { if(e.target.tagName !== 'BUTTON') { activePlateIndex = index; renderCartUI(); } };
        container.appendChild(plateBox);
    });

    const taxAmount = subtotal * (taxRatePercent / 100);
    const grandTotal = subtotal + taxAmount;
    document.getElementById("cart-subtotal").innerText = `Rp ${subtotal.toLocaleString('id-ID')}`;
    document.getElementById("cart-tax").innerText = `Rp ${taxAmount.toLocaleString('id-ID')}`;
    document.getElementById("cart-total").innerText = `Rp ${grandTotal.toLocaleString('id-ID')}`;
}
function addNewPlate() {
    activeOrders[currentOrderIndex].plates.push({ plateId: activeOrders[currentOrderIndex].plates.length + 1, items: [] });
    activePlateIndex = activeOrders[currentOrderIndex].plates.length - 1; 
    preserveUnpaidTables(); renderCartUI();
}
function clearTable() {
    if (activeOrders.length === 0) return;
    if (confirm("Apakah Anda yakin ingin mengosongkan pesanan meja ini?")) { activeOrders[currentOrderIndex].plates = [{ plateId: 1, items: [] }]; preserveUnpaidTables(); renderCartUI(); }
}
function reviewOrder() {
    if (activeOrders.length === 0) return;
    const currentOrder = activeOrders[currentOrderIndex];
    let hasItems = false; currentOrder.plates.forEach(p => { if (p.items.length > 0) hasItems = true; });
    if (!hasItems) return alert("Keranjang meja ini kosong!");

    let receiptHtml = "";
    currentOrder.plates.forEach(plate => {
        if(plate.items.length > 0) {
            receiptHtml += `<div style="font-weight:bold; margin-top:10px;">Piring ${plate.plateId}</div>`;
            plate.items.forEach(item => {
                const itemTotal = item.originalPrice * item.qty;
                receiptHtml += `<div style="display:flex; justify-content:space-between; margin-left:10px; padding: 2px 0;"><span>${item.qty}x ${item.name}</span><span>Rp ${itemTotal.toLocaleString('id-ID')}</span></div>`;
            });
        }
    });
    document.getElementById("review-receipt-items").innerHTML = receiptHtml;

    const list = document.getElementById("promo-list"); list.innerHTML = "";
    db.transaction(["promo_codes"], "readonly").objectStore("promo_codes").getAll().onsuccess = (e) => {
        e.target.result.forEach(promo => { const opt = document.createElement("option"); opt.value = promo.code; opt.innerText = `Diskon ${promo.discountPercent}%`; list.appendChild(opt); });
    };

    document.getElementById("promo-code").value = "";
    document.getElementById("review-modal").classList.remove("hidden");
    calculateReviewTotals(true); 
}
async function calculateReviewTotals(isInitialLoad = false) {
    const currentOrder = activeOrders[currentOrderIndex];
    let baseSubtotal = 0; let effectiveSubtotal = 0; 
    currentOrder.plates.forEach(p => p.items.forEach(i => { baseSubtotal += i.originalPrice * i.qty; effectiveSubtotal += i.price * i.qty; }));

    let menuDiscountTotal = baseSubtotal - effectiveSubtotal; let promoDiscount = 0; let promoName = "";
    const promoInput = document.getElementById("promo-code").value.trim().toUpperCase();

    if (promoInput) {
        const promo = await new Promise(res => {
            const req = db.transaction(["promo_codes"], "readonly").objectStore("promo_codes").get(promoInput);
            req.onsuccess = e => res(e.target.result); req.onerror = () => res(null);
        });
        if (promo) {
            promoName = promo.code;
            currentOrder.plates.forEach(p => p.items.forEach(item => {
                if (item.isDiscountable) {
                    if (!promo.isStackable && item.hasSpecificDiscount) {} 
                    else { promoDiscount += (item.price * item.qty) * (promo.discountPercent / 100); }
                }
            }));
        }
    }

    const taxAmount = (effectiveSubtotal - promoDiscount) * (taxRatePercent / 100);
    const grandTotal = effectiveSubtotal - promoDiscount + taxAmount;
    const totalSavings = menuDiscountTotal + promoDiscount; 

    document.getElementById("review-subtotal").innerText = `Rp ${baseSubtotal.toLocaleString('id-ID')}`;
    const discRow = document.getElementById("review-discount-row");
    if (totalSavings > 0) { discRow.classList.remove("hidden"); document.getElementById("review-discount").innerText = `-Rp ${totalSavings.toLocaleString('id-ID')}`; } 
    else { discRow.classList.add("hidden"); }
    
    document.getElementById("review-tax").innerText = `Rp ${taxAmount.toLocaleString('id-ID')}`;
    document.getElementById("review-grandtotal").innerText = `Rp ${grandTotal.toLocaleString('id-ID')}`;

    if (isInitialLoad) { document.getElementById("pay-cash").value = grandTotal; document.getElementById("pay-qris").value = 0; }
    window.currentReviewTotals = { baseSubtotal, effectiveSubtotal, totalSavings, promoDiscount, promoName, taxAmount, grandTotal };
}
function autoFillPayment(source) {
    const grandTotal = window.currentReviewTotals.grandTotal;
    const cashInput = document.getElementById("pay-cash"); const qrisInput = document.getElementById("pay-qris");
    if (source === 'qris') {
        let qrisVal = Number(qrisInput.value) || 0;
        if (qrisVal < grandTotal) cashInput.value = grandTotal - qrisVal; else cashInput.value = 0;
    } else if (source === 'cash') {
        let cashVal = Number(cashInput.value) || 0;
        if (cashVal < grandTotal) qrisInput.value = grandTotal - cashVal; else qrisInput.value = 0;
    }
}
function closeReview() { document.getElementById("review-modal").classList.add("hidden"); }

// INSTANT PAYMENT & LOCAL STOCK DEDUCTION
async function finalizePayment(shouldPrint) {
    const cashPaid = Number(document.getElementById("pay-cash").value);
    const qrisPaid = Number(document.getElementById("pay-qris").value);
    const currentOrder = activeOrders[currentOrderIndex];
    const totals = window.currentReviewTotals;

    const totalPaid = cashPaid + qrisPaid; const changeDue = totalPaid - totals.grandTotal;

    if (totalPaid < totals.grandTotal) if (!confirm("Peringatan: Jumlah yang dibayar kurang dari Total Keseluruhan. Tetap lanjutkan?")) return;
    const orderId = "ORD-" + Date.now();
    const finalStatus = shouldPrint ? "Paid" : "Paid but not printed";

    if (shouldPrint) { await buildPrintableReceipt(orderId, currentOrder, totals, cashPaid, qrisPaid, changeDue); window.print(); } 
    else if (changeDue > 0) { alert(`Pembayaran Berhasil!\nKembalian: Rp ${changeDue.toLocaleString('id-ID')}`); }

    const orderPayload = {
        orderId: orderId, timestamp: new Date().toISOString(), cashier: currentCashier, shiftId: currentShiftId, tablePrefix: currentOrder.name,
        customerName: currentOrder.customerName, customerPhone: currentOrder.customerPhone, orderStatus: finalStatus, syncStatus: "Pending", voidAuth: "N/A", 
        plates: currentOrder.plates, subtotal: totals.baseSubtotal, discounts: totals.totalSavings, promoName: totals.promoName, grandTotal: totals.grandTotal,
        paymentMethod: (cashPaid > 0 && qrisPaid > 0) ? "Split" : (qrisPaid > 0 ? "QRIS" : "Cash"), cashAmount: cashPaid, qrisAmount: qrisPaid
    };

    const txMenu = db.transaction(["menu"], "readwrite");
    const storeMenu = txMenu.objectStore("menu");
    currentOrder.plates.forEach(p => p.items.forEach(cartItem => {
        storeMenu.get(cartItem.itemId).onsuccess = (ev) => {
            const menuItem = ev.target.result;
            if (menuItem && menuItem.trackStock) {
                menuItem.currentStock = Math.max(0, menuItem.currentStock - cartItem.qty);
                storeMenu.put(menuItem);
            }
        };
    }));
    txMenu.oncomplete = () => { renderProductGrid(); };

    db.transaction(["orders"], "readwrite").objectStore("orders").add(orderPayload);
    closeReview(); activeOrders.splice(currentOrderIndex, 1);
    currentOrderIndex = 0; activePlateIndex = 0; 
    preserveUnpaidTables(); renderCustomerTabs(); renderCartUI(); runBackgroundSync();
}
async function getDynamicSettings() {
    return new Promise(res => {
        let req = db.transaction(["settings"], "readonly").objectStore("settings").getAll();
        req.onsuccess = e => { let s = {}; e.target.result.forEach(row => s[row.key] = row.value); res(s); };
    });
}
async function buildPrintableReceipt(orderId, order, totals, cash, qris, changeDue) {
    const settings = await getDynamicSettings();
    const storeName = settings["Store_Name"] || "KSB POS"; const storeAddress = settings["Store_Address"] || "Surabaya, Indonesia";
    const footer1 = settings["Footer_1"] || "TERIMA KASIH!"; const footer2 = settings["Footer_2"] || "Silakan datang kembali"; const footer3 = settings["Footer_3"] || ""; 
    const printArea = document.getElementById("printable-area"); const dateStr = new Date().toLocaleString('id-ID');
    
    let itemsHtml = "";
    order.plates.forEach(plate => {
        if(plate.items.length > 0) {
            itemsHtml += `<div style="font-weight:bold; margin-top:8px;">Piring ${plate.plateId}</div>`;
            plate.items.forEach(item => { 
                const lineTotal = item.qty * item.originalPrice;
                itemsHtml += `<div style="display:flex; justify-content:space-between; margin-bottom: 2px;"><span>${item.qty}x ${item.name}</span><span>${lineTotal.toLocaleString('id-ID')}</span></div>`; 
            });
        }
    });

    let discountHtml = totals.totalSavings > 0 ? `<div style="display:flex; justify-content:space-between;"><span>Total Diskon:</span><span>-Rp ${totals.totalSavings.toLocaleString('id-ID')}</span></div>` : "";
    let promoHtml = totals.promoName ? `<div style="display:flex; justify-content:space-between; font-size:10px; color:#555;"><span>(Promo Aktif:</span><span>${totals.promoName})</span></div>` : "";

    printArea.innerHTML = `
        <div style="text-align:center; margin-bottom:10px;"><h2 style="margin:0;">${storeName}</h2><div style="font-size:10px;">${storeAddress}</div><div style="font-size:10px;">${dateStr}</div></div>
        <div style="border-top:1px dashed #000; border-bottom:1px dashed #000; padding:5px 0; margin-bottom:5px; font-size: 11px;">
            <div>Pesanan: ${orderId}</div><div>Meja: ${order.name}</div><div>Pelanggan: ${order.customerName}</div><div>Kasir: ${currentCashier}</div>
        </div>
        ${itemsHtml}
        <div style="border-top:1px dashed #000; margin-top:10px; padding-top:5px;">
            <div style="display:flex; justify-content:space-between;"><span>Subtotal:</span><span>Rp ${totals.baseSubtotal.toLocaleString('id-ID')}</span></div>
            ${discountHtml}${promoHtml}
            <div style="display:flex; justify-content:space-between;"><span>Pajak:</span><span>Rp ${totals.taxAmount.toLocaleString('id-ID')}</span></div>
            <div style="display:flex; justify-content:space-between; font-weight:bold; font-size:14px; margin-top:5px; border-bottom: 1px solid #000; padding-bottom: 5px;"><span>TOTAL:</span><span>Rp ${totals.grandTotal.toLocaleString('id-ID')}</span></div>
        </div>
        <div style="margin-top:5px; font-size:11px;">
            ${cash > 0 ? `<div style="display:flex; justify-content:space-between;"><span>Tunai:</span><span>Rp ${cash.toLocaleString('id-ID')}</span></div>` : ''}
            ${qris > 0 ? `<div style="display:flex; justify-content:space-between;"><span>QRIS:</span><span>Rp ${qris.toLocaleString('id-ID')}</span></div>` : ''}
            ${changeDue > 0 ? `<div style="display:flex; justify-content:space-between; font-weight:bold; margin-top: 5px;"><span>KEMBALIAN:</span><span>Rp ${changeDue.toLocaleString('id-ID')}</span></div>` : ''}
        </div>
        <div style="text-align:center; margin-top:15px; font-weight:bold; font-size: 12px;">${footer1}</div>
        <div style="text-align:center; margin-top:2px; font-size: 10px;">${footer2}</div>
        ${footer3 ? `<div style="text-align:center; margin-top:2px; font-size: 10px;">${footer3}</div>` : ''}
    `;
}

// ---------------------------------------------------------
// CONTINUOUS DRAWER ENGINE 
// ---------------------------------------------------------
function calculateLiveDrawer(callback) {
    let liveDrawer = window.masterDrawerBalance || 0; 
    
    let tx = db.transaction(["orders", "expenses", "cash_drops"], "readonly");
    let ordersReq = tx.objectStore("orders").getAll();
    let expReq = tx.objectStore("expenses").getAll();
    let dropReq = tx.objectStore("cash_drops").getAll();
    
    tx.oncomplete = () => {
        ordersReq.result.forEach(o => { if (o.syncStatus === "Pending" && o.orderStatus.startsWith("Paid")) liveDrawer += (o.cashAmount || 0); });
        expReq.result.forEach(e => { if (e.syncStatus === "Pending" && e.status === "Active") liveDrawer -= (e.amount || 0); });
        dropReq.result.forEach(d => { if (d.syncStatus === "Pending") liveDrawer -= (d.toAdmin + d.toBank); });
        callback(liveDrawer);
    };
}

// ---------------------------------------------------------
// HISTORY & VOIDS
// ---------------------------------------------------------
function openHistoryModal() { document.getElementById("history-modal").classList.remove("hidden"); renderHistoryList('orders'); }
function closeHistoryModal() { document.getElementById("history-modal").classList.add("hidden"); }
function renderHistoryList(type) {
    const container = document.getElementById("history-container"); container.innerHTML = "";
    
    if (type === 'orders') {
        db.transaction(["orders"], "readonly").objectStore("orders").getAll().onsuccess = (e) => {
            const shiftOrders = e.target.result.filter(o => o.shiftId === currentShiftId).reverse(); 
            if(shiftOrders.length === 0) return container.innerHTML = `<div style="padding:20px; text-align:center;">Belum ada pesanan pada shift ini.</div>`;
            shiftOrders.forEach(o => {
                let badge = o.orderStatus === "Voided" ? `<span class="status-badge status-voided">Dibatalkan</span>` :
                            o.orderStatus === "Void Pending" ? `<span class="status-badge status-pending">Menunggu Admin</span>` :
                            `<span class="status-badge status-paid">${o.orderStatus}</span>`; 
                let btn = (o.orderStatus === "Paid" || o.orderStatus === "Paid but not printed") ? `<button onclick="requestVoid('orders', '${o.orderId}')" style="background:#e74c3c; color:white; border:none; padding:5px 10px; border-radius:4px; cursor:pointer;">Void</button>` : '';
                container.innerHTML += `<div class="history-row"><div><strong>${o.tablePrefix} (${o.customerName})</strong><br><small style="color:#7f8c8d;">${new Date(o.timestamp).toLocaleTimeString()} | Rp ${o.grandTotal.toLocaleString('id-ID')}</small></div><div style="display:flex; align-items:center; gap:10px;">${badge} ${btn}</div></div>`;
            });
        };
    } else if (type === 'expenses') {
        db.transaction(["expenses"], "readonly").objectStore("expenses").getAll().onsuccess = (e) => {
            const shiftExpenses = e.target.result.filter(exp => exp.shiftId === currentShiftId).reverse();
            if(shiftExpenses.length === 0) return container.innerHTML = `<div style="padding:20px; text-align:center;">Belum ada pengeluaran pada shift ini.</div>`;
            shiftExpenses.forEach(exp => {
                let badge = exp.status === "Voided" ? `<span class="status-badge status-voided">Dibatalkan</span>` :
                            exp.status === "Void Pending" ? `<span class="status-badge status-pending">Menunggu Admin</span>` :
                            `<span class="status-badge status-paid">Aktif</span>`;
                let btn = exp.status !== "Voided" && exp.status !== "Void Pending" ? `<button onclick="requestVoid('expenses', '${exp.expenseId}')" style="background:#e74c3c; color:white; border:none; padding:5px 10px; border-radius:4px; cursor:pointer;">Void</button>` : '';
                container.innerHTML += `<div class="history-row"><div><strong>${exp.category}</strong><br><small style="color:#7f8c8d;">${new Date(exp.timestamp).toLocaleTimeString()} | Rp ${exp.amount.toLocaleString('id-ID')}</small><br><small>${exp.description}</small></div><div style="display:flex; align-items:center; gap:10px;">${badge} ${btn}</div></div></div>`;
            });
        };
    } else if (type === 'shifts') {
        db.transaction(["local_shift_history"], "readonly").objectStore("local_shift_history").getAll().onsuccess = (e) => {
            const shifts = e.target.result.reverse();
            if(shifts.length === 0) return container.innerHTML = `<div style="padding:20px; text-align:center;">Belum ada riwayat shift yang tercatat di perangkat ini.</div>`;
            shifts.forEach(s => {
                container.innerHTML += `
                    <div class="history-row">
                        <div><strong>${s.shiftId} (${s.cashier})</strong><br><small style="color:#7f8c8d;">Logout: ${new Date(s.logoutTime).toLocaleString('id-ID')}</small></div>
                        <button onclick="viewPastShift('${s.shiftId}')" style="background:#3498db; color:white; border:none; padding:5px 10px; border-radius:4px; cursor:pointer;">Lihat Laporan</button>
                    </div>`;
            });
        };
    }
}
function requestVoid(type, id) { currentVoidTarget = { type, id }; document.getElementById("admin-void-pin").value = ""; document.getElementById("admin-void-modal").classList.remove("hidden"); }
function closeAdminVoidModal() { document.getElementById("admin-void-modal").classList.add("hidden"); }
function submitRemoteVoid() {
    const type = currentVoidTarget.type; const id = currentVoidTarget.id; const storeName = type === 'orders' ? "orders" : "expenses";
    db.transaction([storeName], "readwrite").objectStore(storeName).get(id).onsuccess = (e) => {
        const item = e.target.result;
        if (type === 'orders') item.orderStatus = "Void Pending"; else item.status = "Void Pending";
        db.transaction([storeName], "readwrite").objectStore(storeName).put(item); renderHistoryList(type); 
    };
    db.transaction(["void_requests"], "readwrite").objectStore("void_requests").add({ id: id, type: type, status: "Void Pending", authName: "Waiting" });
    closeAdminVoidModal(); runBackgroundSync();
}
async function confirmAdminVoid() {
    const pin = document.getElementById("admin-void-pin").value; if (!pin) return alert("Harap masukkan PIN.");
    const settings = await getDynamicSettings(); const masterPin = String(settings["Master_PIN"]); const isMaster = (pin === masterPin);
    
    db.transaction(["staff"], "readonly").objectStore("staff").get(pin).onsuccess = (e) => {
        const staff = e.target.result; const isAdmin = (staff && staff.role.toLowerCase() === 'admin');

        if (isMaster || isAdmin) {
            const authName = isMaster ? "Admin Utama" : staff.name;
            const type = currentVoidTarget.type; const id = currentVoidTarget.id; const storeName = type === 'orders' ? "orders" : "expenses";
            
            db.transaction([storeName], "readwrite").objectStore(storeName).get(id).onsuccess = (ev) => {
                const item = ev.target.result;
                if (type === 'orders') { item.orderStatus = "Voided"; item.voidAuth = authName; applyVoidAftermath(item); } 
                else { item.status = "Voided"; item.voidAuth = authName; applyVoidAftermathExpense(item); }
                item.syncStatus = "Pending"; db.transaction([storeName], "readwrite").objectStore(storeName).put(item); renderHistoryList(type);
            };
            
            db.transaction(["void_requests"], "readwrite").objectStore("void_requests").add({ id: id, type: type, status: "Voided", authName: authName });
            closeAdminVoidModal(); runBackgroundSync(); alert("Transaksi dibatalkan instan oleh: " + authName);
        } else { alert("PIN tidak valid atau Anda tidak memiliki akses Admin."); }
    };
}

// ---------------------------------------------------------
// STRICT LOGOUT SEQUENCE & SHIFT REPORTING
// ---------------------------------------------------------
function viewPastShift(shiftId) {
    db.transaction(["past_shifts", "local_shift_history"], "readonly").objectStore("local_shift_history").get(shiftId).onsuccess = (e) => {
        let s = e.target.result; 
        if(!s) {
            db.transaction(["past_shifts"], "readonly").objectStore("past_shifts").get(shiftId).onsuccess = (ev) => {
                s = ev.target.result;
                if(!s) return;
                populateShiftModal(s, true);
            };
        } else {
            populateShiftModal(s, true);
        }
    };
}

function populateShiftModal(s, isPast) {
    document.getElementById("shift-customers").innerText = s.totalCustomers; document.getElementById("shift-plates").innerText = s.totalPlates;
    document.getElementById("shift-omset").innerText = `Rp ${Number(String(s.totalOmset).replace(/[^\d.-]/g, '')).toLocaleString('id-ID')}`;
    document.getElementById("shift-cash").innerText = `Rp ${Number(String(s.totalCash).replace(/[^\d.-]/g, '')).toLocaleString('id-ID')}`;
    document.getElementById("shift-qris").innerText = `Rp ${Number(String(s.totalQris).replace(/[^\d.-]/g, '')).toLocaleString('id-ID')}`;
    document.getElementById("shift-expenses").innerText = `Rp ${Number(String(s.totalExpenses).replace(/[^\d.-]/g, '')).toLocaleString('id-ID')}`;
    document.getElementById("shift-net").innerText = `Rp ${Number(String(s.netCash).replace(/[^\d.-]/g, '')).toLocaleString('id-ID')}`;
    
    let foodStr = typeof s.foodSummary === 'string' ? s.foodSummary : (s.foodSummaryStr || "");
    if (!foodStr && typeof s.foodSummary === 'object') {
        for (const [name, qty] of Object.entries(s.foodSummary)) { foodStr += ` • ${qty}x ${name}\n`; }
    }
    document.getElementById("shift-food-list").innerHTML = `<div style="font-size:12px;">${foodStr.replace(/\n/g, '<br>')}</div>`;
    
    window.currentShiftData = {
        isPast: isPast, shiftId: s.shiftId, cashier: s.cashier, totalCustomers: s.totalCustomers, totalPlates: s.totalPlates,
        totalOmset: Number(String(s.totalOmset).replace(/[^\d.-]/g, '')), totalCash: Number(String(s.totalCash).replace(/[^\d.-]/g, '')),
        totalQris: Number(String(s.totalQris).replace(/[^\d.-]/g, '')), totalExpenses: Number(String(s.totalExpenses).replace(/[^\d.-]/g, '')),
        netCash: Number(String(s.netCash).replace(/[^\d.-]/g, '')), foodStr: foodStr, foodSummary: s.foodSummary || {}
    };

    document.getElementById("shift-modal-active-buttons").style.display = isPast ? "none" : "flex"; 
    document.getElementById("shift-modal-past-buttons").style.display = isPast ? "flex" : "none";
    document.getElementById("shift-report-modal").classList.remove("hidden");
}

function openShiftReport() {
    let totalCustomers = 0; let totalPlates = 0; let totalCash = 0; let totalQris = 0; let totalOmset = 0; let totalExpenses = 0; let foodSummary = {};

    db.transaction(["orders"], "readonly").objectStore("orders").getAll().onsuccess = (e) => {
        const validOrders = e.target.result.filter(o => o.shiftId === currentShiftId && (o.orderStatus === "Paid" || o.orderStatus === "Paid but not printed"));
        validOrders.forEach(o => {
            totalCustomers++;
            let activePlates = o.plates.filter(p => p.items.length > 0).length; totalPlates += activePlates;
            totalCash += (o.cashAmount || 0); totalQris += (o.qrisAmount || 0); totalOmset += (o.grandTotal || 0);
            o.plates.forEach(p => p.items.forEach(i => { if(!foodSummary[i.name]) foodSummary[i.name] = 0; foodSummary[i.name] += i.qty; }));
        });

        db.transaction(["expenses"], "readonly").objectStore("expenses").getAll().onsuccess = (e2) => {
            const validExp = e2.target.result.filter(exp => exp.shiftId === currentShiftId && exp.status !== "Voided" && exp.status !== "Void Pending");
            validExp.forEach(exp => { totalExpenses += (exp.amount || 0); });

            calculateLiveDrawer((liveDrawer) => {
                let s = { shiftId: currentShiftId, cashier: currentCashier, totalCustomers: totalCustomers, totalPlates: totalPlates, totalOmset: totalOmset, totalCash: totalCash, totalQris: totalQris, totalExpenses: totalExpenses, netCash: liveDrawer, foodSummary: foodSummary };
                populateShiftModal(s, false);
            });
        };
    };
}

async function printShiftReport() {
    const settings = await getDynamicSettings();
    const storeName = settings["Store_Name"] || "KSB POS"; const storeAddress = settings["Store_Address"] || "Surabaya, Indonesia";
    const printArea = document.getElementById("printable-area"); const dateStr = new Date().toLocaleString('id-ID');
    const data = window.currentShiftData;

    let foodHtml = "";
    if (data.isPast) { foodHtml = `<div style="font-size:11px; text-align:left; white-space:pre-wrap;">${data.foodStr}</div>`; } 
    else { for (const [name, qty] of Object.entries(data.foodSummary)) { foodHtml += `<div style="display:flex; justify-content:space-between; margin-bottom:2px;"><span>${name}</span><span>${qty}x</span></div>`; } }

    const printShiftId = data.isPast ? data.shiftId : currentShiftId; const printCashier = data.isPast ? data.cashier : currentCashier;

    printArea.innerHTML = `
        <div style="text-align:center; margin-bottom:10px;"><h2 style="margin:0;">${storeName}</h2><div style="font-size:10px;">${storeAddress}</div><div style="font-size:10px;">${dateStr}</div></div>
        <div style="border-top:1px dashed #000; border-bottom:1px dashed #000; padding:5px 0; margin-bottom:10px; font-size: 14px; text-align:center; font-weight:bold;">LAPORAN SHIFT</div>
        <div style="font-size: 11px; margin-bottom:10px;">
            <div>ID Shift: ${printShiftId}</div><div>Kasir: ${printCashier}</div><div>Pelanggan: ${data.totalCustomers}</div><div>Piring Digunakan: ${data.totalPlates}</div>
        </div>
        <div style="border-bottom:1px dashed #000; margin-bottom:5px; font-weight:bold;">FINANSIAL</div>
        <div style="display:flex; justify-content:space-between;"><span>Omset Kotor:</span><span>Rp ${data.totalOmset.toLocaleString('id-ID')}</span></div>
        <div style="display:flex; justify-content:space-between;"><span>QRIS Diterima:</span><span>Rp ${data.totalQris.toLocaleString('id-ID')}</span></div>
        <div style="display:flex; justify-content:space-between; margin-top:5px; font-weight:bold;"><span>Kas Diterima:</span><span>Rp ${data.totalCash.toLocaleString('id-ID')}</span></div>
        <div style="display:flex; justify-content:space-between; color:#e74c3c;"><span>Pengeluaran:</span><span>-Rp ${data.totalExpenses.toLocaleString('id-ID')}</span></div>
        <div style="display:flex; justify-content:space-between; font-weight:bold; font-size:14px; margin-top:5px; border-top: 1px solid #000; padding-top: 5px;"><span>UANG DI LACI:</span><span>Rp ${data.netCash.toLocaleString('id-ID')}</span></div>
        <div style="border-bottom:1px dashed #000; margin-top:15px; margin-bottom:5px; font-weight:bold;">ITEM TERJUAL</div>${foodHtml}
        <div style="text-align:center; margin-top:20px; font-weight:bold; font-size: 12px;">AKHIR LAPORAN</div>
    `;
    window.print();
}

function closeShiftReport() { document.getElementById("shift-report-modal").classList.add("hidden"); }

function initiateLogoutSequence() { 
    document.getElementById("shift-report-modal").classList.add("hidden"); 
    openCashDrop(true); 
}

function openCashDrop(forLogout = false) {
    isLoggingOut = forLogout;
    document.getElementById("cash-drop-title").innerText = isLoggingOut ? "🔒 Setoran Akhir Shift" : "🏦 Setor Kas";
    document.getElementById("btn-drop-cancel").innerText = isLoggingOut ? "Batal Keluar" : "Batal";
    document.getElementById("btn-drop-confirm").innerText = isLoggingOut ? "Konfirmasi & Keluar" : "Simpan Catatan";
    
    document.getElementById("drop-admin").value = 0; document.getElementById("drop-bank").value = 0; document.getElementById("drop-notes").value = "";
    
    calculateLiveDrawer((liveAmount) => {
        document.getElementById("live-drawer-display").innerText = `Rp ${liveAmount.toLocaleString('id-ID')}`;
        document.getElementById("cash-drop-modal").classList.remove("hidden");
    });
}

function closeCashDrop() { 
    document.getElementById("cash-drop-modal").classList.add("hidden"); 
    isLoggingOut = false; 
}

function submitCashDrop() {
    const adminAmt = Number(document.getElementById("drop-admin").value) || 0;
    const bankAmt = Number(document.getElementById("drop-bank").value) || 0;
    const notes = document.getElementById("drop-notes").value || (isLoggingOut ? "Akhir Shift" : "Setoran Tengah Shift");
    
    calculateLiveDrawer((liveAmount) => {
        const leftInDrawer = liveAmount - adminAmt - bankAmt;
        const payload = {
            dropId: "DRP-" + Date.now(), timestamp: new Date().toISOString(), cashier: currentCashier, shiftId: currentShiftId,
            toAdmin: adminAmt, toBank: bankAmt, leftInDrawer: leftInDrawer, notes: notes, syncStatus: "Pending"
        };
        
        try { db.transaction(["cash_drops"], "readwrite").objectStore("cash_drops").put(payload); } catch(e) {}
        
        document.getElementById("cash-drop-modal").classList.add("hidden"); 
        
        if (isLoggingOut) { 
            executeFinalLogout(leftInDrawer); 
        } else { 
            runBackgroundSync();
            alert(`Setoran Kas Tercatat!\nSisa di Laci: Rp ${leftInDrawer.toLocaleString('id-ID')}`); 
        }
    });
}

// 5. The Bulletproof Execution Engine
async function executeFinalLogout(netCash) { 
    const data = window.currentShiftData || {};
    const shiftPayload = {
        shiftId: currentShiftId || ("SHF-" + Date.now()), timestamp: new Date().toISOString(), cashier: currentCashier || "Unknown", 
        loginTime: currentLoginTime || new Date().toISOString(), logoutTime: new Date().toISOString(), 
        totalCustomers: data.totalCustomers || 0, totalPlates: data.totalPlates || 0, totalOmset: data.totalOmset || 0, 
        totalCash: data.totalCash || 0, totalQris: data.totalQris || 0, totalExpenses: data.totalExpenses || 0, 
        netCash: netCash || 0, foodSummary: data.foodSummary || {}, syncStatus: "Pending"
    };

    const statusText = document.getElementById("network-text");
    if(statusText) statusText.innerText = "LOGOUT... ⏳";
    document.body.style.pointerEvents = "none"; 
    document.body.style.opacity = "0.7";

    try {
        const tx = db.transaction(["local_shift_history", "shift_reports", "active_shifts"], "readwrite");
        tx.objectStore("local_shift_history").put(shiftPayload); 
        tx.objectStore("shift_reports").put(shiftPayload);       
        if (currentPin) tx.objectStore("active_shifts").delete(currentPin); 

        localStorage.removeItem(`unpaid_cache_${currentShiftId}`); 
        localStorage.removeItem("pos_active_session"); 

        if (navigator.onLine) {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000); 

            try {
                const response = await fetch(API_URL, { 
                    method: "POST", 
                    body: JSON.stringify({ action: "syncShiftReport", data: shiftPayload }),
                    signal: controller.signal
                });
                clearTimeout(timeoutId);
                const json = await response.json();
                
                if (json.status === "Success") {
                    const tx2 = db.transaction(["shift_reports"], "readwrite");
                    tx2.objectStore("shift_reports").delete(shiftPayload.shiftId);
                }
            } catch (netError) {
                console.warn("Network delayed or offline. Data safely stored locally.");
            }
        }
    } catch (fatalError) {
        console.error("Local database error during logout.", fatalError);
    } finally {
        window.location.reload(); 
    }
}

// ---------------------------------------------------------
// EXPENSES & SETTINGS
// ---------------------------------------------------------
function openExpenseModal() {
    document.getElementById("expense-modal").classList.remove("hidden");
    const list = document.getElementById("expense-category-list"); list.innerHTML = "";
    db.transaction(["expense_categories"], "readonly").objectStore("expense_categories").getAll().onsuccess = (e) => { e.target.result.forEach(cat => { const opt = document.createElement("option"); opt.value = cat.name; list.appendChild(opt); }); };
}
function closeExpenseModal() { document.getElementById("expense-modal").classList.add("hidden"); }
function saveExpense() {
    const amount = Number(document.getElementById("exp-amount").value);
    const category = document.getElementById("exp-category").value.trim();
    if (amount <= 0 || !category) return alert("Harap masukkan jumlah dan kategori yang valid.");
    db.transaction(["expense_categories"], "readwrite").objectStore("expense_categories").put({ name: category });

    const payload = { expenseId: "EXP-" + Date.now(), timestamp: new Date().toISOString(), cashier: currentCashier, shiftId: currentShiftId, category: category, description: document.getElementById("exp-desc").value || "-", amount: amount, status: "Active", syncStatus: "Pending" };
    db.transaction(["expenses"], "readwrite").objectStore("expenses").add(payload);
    closeExpenseModal(); document.getElementById("exp-amount").value = ""; document.getElementById("exp-category").value = ""; document.getElementById("exp-desc").value = ""; alert("Pengeluaran Tercatat!"); runBackgroundSync();
}
function openSettings() { document.getElementById("settings-modal").classList.remove("hidden"); }
function closeSettings() { document.getElementById("settings-modal").classList.add("hidden"); }

// ---------------------------------------------------------
// BACKGROUND SYNC ENGINE (PUSH ONLY)
// ---------------------------------------------------------
async function runBackgroundSync() {
    if (!navigator.onLine) return; 
    let tx = db.transaction(["orders"], "readonly"); let items = await new Promise(res => tx.objectStore("orders").getAll().onsuccess = e => res(e.target.result));
    for (const order of items) {
        if (order.syncStatus === "Pending") {
            try { let r = await fetch(API_URL, { method: "POST", body: JSON.stringify({ action: "syncOrder", data: order }) }); if ((await r.json()).status === "Success") { order.syncStatus = "Synced"; db.transaction(["orders"], "readwrite").objectStore("orders").put(order); } } catch(e) {}
        }
    }

    tx = db.transaction(["expenses"], "readonly"); items = await new Promise(res => tx.objectStore("expenses").getAll().onsuccess = e => res(e.target.result));
    for (const exp of items) {
        if (exp.syncStatus === "Pending") {
            try { let r = await fetch(API_URL, { method: "POST", body: JSON.stringify({ action: "syncExpense", data: exp }) }); if ((await r.json()).status === "Success") { exp.syncStatus = "Synced"; db.transaction(["expenses"], "readwrite").objectStore("expenses").put(exp); } } catch(e) {}
        }
    }

    tx = db.transaction(["cash_drops"], "readonly"); items = await new Promise(res => tx.objectStore("cash_drops").getAll().onsuccess = e => res(e.target.result));
    for (const drop of items) {
        if (drop.syncStatus === "Pending") {
            try { let r = await fetch(API_URL, { method: "POST", body: JSON.stringify({ action: "syncCashDrop", data: drop }) }); if ((await r.json()).status === "Success") { drop.syncStatus = "Synced"; db.transaction(["cash_drops"], "readwrite").objectStore("cash_drops").put(drop); } } catch(e) {}
        }
    }

    tx = db.transaction(["void_requests"], "readonly"); items = await new Promise(res => tx.objectStore("void_requests").getAll().onsuccess = e => res(e.target.result));
    for (const req of items) {
        try {
            const actionType = req.type === 'orders' ? "requestOrderVoid" : "requestExpenseVoid"; const payload = req.type === 'orders' ? { orderId: req.id, status: req.status, authName: req.authName } : { expenseId: req.id, status: req.status, authName: req.authName };
            let r = await fetch(API_URL, { method: "POST", body: JSON.stringify({ action: actionType, ...payload }) }); if ((await r.json()).status === "Success") { db.transaction(["void_requests"], "readwrite").objectStore("void_requests").delete(req.id); }
        } catch(e) {}
    }

    tx = db.transaction(["shift_reports"], "readonly"); items = await new Promise(res => tx.objectStore("shift_reports").getAll().onsuccess = e => res(e.target.result));
    for (const report of items) {
        if (report.syncStatus === "Pending") {
            try { let r = await fetch(API_URL, { method: "POST", body: JSON.stringify({ action: "syncShiftReport", data: report }) }); if ((await r.json()).status === "Success") { db.transaction(["shift_reports"], "readwrite").objectStore("shift_reports").delete(report.shiftId); } } catch(e) {}
        }
    }
    
    tx = db.transaction(["unsynced_members"], "readonly"); items = await new Promise(res => tx.objectStore("unsynced_members").getAll().onsuccess = e => res(e.target.result));
    for (const mem of items) {
        try { let r = await fetch(API_URL, { method: "POST", body: JSON.stringify({ action: "syncMember", data: mem }) }); if ((await r.json()).status === "Success") { db.transaction(["unsynced_members"], "readwrite").objectStore("unsynced_members").delete(mem.phone); } } catch(e) {}
    }
}

window.onload = async () => { 
    await initDB(); 
    await syncMasterData(false); 
    loadSettingsForCart(); 
    checkActiveSession(); 
    window.setInterval(runBackgroundSync, 15000); 
    window.setInterval(() => syncMasterData(true), 60000); 
};
