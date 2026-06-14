const API_URL = "https://script.google.com/macros/s/AKfycbz228gxhOZUW1PyOZVbj1XX6B7SxmYRiZlyLlYSp38sBZzCZKpo4O5baORr4DxvIRjy/exec";
const DB_NAME = "Buffet_POS_DB";
const DB_VERSION = 18; 
let db;

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
    e.preventDefault(); deferredPrompt = e;
    const installBtn = document.getElementById('top-install-btn');
    if (installBtn) installBtn.classList.remove('hidden');
});
document.getElementById('top-install-btn')?.addEventListener('click', async () => {
    if (deferredPrompt) { 
        deferredPrompt.prompt(); 
        const { outcome } = await deferredPrompt.userChoice; 
        if (outcome === 'accepted') { document.getElementById('top-install-btn').classList.add('hidden'); } 
        deferredPrompt = null; 
    }
});

// ---------------------------------------------------------
// DATABASE INITIALIZATION
// ---------------------------------------------------------
function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = (event) => {
            db = event.target.result;
            if (!db.objectStoreNames.contains("staff")) db.createObjectStore("staff", { keyPath: "pin" });
            if (!db.objectStoreNames.contains("menu")) db.createObjectStore("menu", { keyPath: "itemId" });
            if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings", { keyPath: "key" });
            if (!db.objectStoreNames.contains("orders")) db.createObjectStore("orders", { keyPath: "orderId" });
            if (!db.objectStoreNames.contains("expenses")) db.createObjectStore("expenses", { keyPath: "expenseId" });
            if (!db.objectStoreNames.contains("members")) db.createObjectStore("members", { keyPath: "phone" });
            if (!db.objectStoreNames.contains("unsynced_members")) db.createObjectStore("unsynced_members", { keyPath: "phone" });
            if (!db.objectStoreNames.contains("expense_categories")) db.createObjectStore("expense_categories", { keyPath: "name" });
            if (!db.objectStoreNames.contains("void_requests")) db.createObjectStore("void_requests", { keyPath: "id" }); 
            if (!db.objectStoreNames.contains("promo_codes")) db.createObjectStore("promo_codes", { keyPath: "code" }); 
            if (!db.objectStoreNames.contains("shift_reports")) db.createObjectStore("shift_reports", { keyPath: "shiftId" }); 
            if (!db.objectStoreNames.contains("past_shifts")) db.createObjectStore("past_shifts", { keyPath: "shiftId" }); 
            if (!db.objectStoreNames.contains("active_shifts")) db.createObjectStore("active_shifts", { keyPath: "pin" }); 
            if (!db.objectStoreNames.contains("cash_drops")) db.createObjectStore("cash_drops", { keyPath: "dropId" }); 
            if (!db.objectStoreNames.contains("local_shift_history")) db.createObjectStore("local_shift_history", { keyPath: "shiftId" }); 
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
    const pinInput = document.getElementById("cashier-pin").value;
    if (!pinInput) return alert("Please enter a PIN");

    db.transaction(["staff"], "readonly").objectStore("staff").get(pinInput).onsuccess = (e) => {
        const staffMember = e.target.result;
        if (staffMember) {
            db.transaction(["active_shifts"], "readonly").objectStore("active_shifts").get(staffMember.pin).onsuccess = (shiftRes) => {
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
        } else { alert("Invalid PIN."); document.getElementById("cashier-pin").value = ""; }
    };
}

function checkActiveSession() {
    const savedSession = localStorage.getItem("pos_active_session");
    if (savedSession) { loadSessionData(JSON.parse(savedSession)); }
}

function loadSessionData(session) {
    currentCashier = session.name; currentPin = session.pin; currentShiftId = session.shiftId; currentLoginTime = session.loginTime;
    document.getElementById("login-screen").classList.add("hidden"); document.getElementById("pos-screen").classList.remove("hidden");
    document.getElementById("display-cashier").innerText = currentCashier; document.getElementById("cashier-pin").value = "";
    document.getElementById("shift-login-indicator").innerText = `Logged in: ${new Date(currentLoginTime).toLocaleTimeString('id-ID')}`;
    
    restoreUnpaidTables(); loadMenuUI(); initTabs(); 
}

function lockScreen() { localStorage.removeItem("pos_active_session"); window.location.reload(); }

// ---------------------------------------------------------
// MASTER DATA SYNC (AND VISUAL REFRESH)
// ---------------------------------------------------------
async function loginScreenSync() {
    const btn = document.getElementById("login-sync-btn");
    btn.disabled = true;
    await syncMasterData();
    btn.disabled = false;
}

async function syncMasterData() {
    const statusText = document.getElementById("network-text");
    const loginStatus = document.getElementById("login-sync-status");
    
    if (!navigator.onLine) { 
        if(statusText) statusText.innerText = "Offline Mode"; 
        if(loginStatus) loginStatus.innerText = "Status: Offline Mode ❌"; 
        const dot = document.getElementById("network-dot"); if(dot) dot.style.backgroundColor = "#e74c3c"; 
        return; 
    }
    
    if(statusText) statusText.innerText = "Syncing...";
    if(loginStatus) loginStatus.innerText = "Status: Syncing with Server... ⏳"; 
    
    try {
        const response = await fetch(API_URL); const result = await response.json();
        if (result.status === "Success") {
            window.masterDrawerBalance = result.masterDrawerBalance || 0; 
            
            const transaction = db.transaction(["staff", "menu", "settings", "members", "expense_categories", "promo_codes", "past_shifts"], "readwrite");
            
            const staffStore = transaction.objectStore("staff"); staffStore.clear(); result.data.staff.forEach(person => staffStore.add(person));
            const menuStore = transaction.objectStore("menu"); menuStore.clear(); result.data.menu.forEach(item => menuStore.add(item));
            const settingsStore = transaction.objectStore("settings"); settingsStore.clear(); for (const [key, value] of Object.entries(result.data.settings)) { settingsStore.add({ key: key, value: value }); }
            const membersStore = transaction.objectStore("members"); membersStore.clear(); result.data.members.forEach(member => membersStore.add(member));
            const expCatStore = transaction.objectStore("expense_categories"); expCatStore.clear(); if (result.data.expenseCategories) result.data.expenseCategories.forEach(cat => expCatStore.add({ name: cat }));
            const promoStore = transaction.objectStore("promo_codes"); promoStore.clear(); if (result.data.promoCodes) result.data.promoCodes.forEach(p => promoStore.add(p));
            const pastShiftsStore = transaction.objectStore("past_shifts"); pastShiftsStore.clear(); if (result.data.pastShifts) result.data.pastShifts.forEach(s => pastShiftsStore.add(s));

            if (result.data.authStatuses) processVoidApprovals(result.data.authStatuses);
            
            globalMenuData = result.data.menu;
            if(!document.getElementById("pos-screen").classList.contains("hidden")) { renderProductGrid(); }

            if(statusText) statusText.innerText = "Online & Synced"; 
            if(loginStatus) loginStatus.innerText = "Status: Database Synced ✅"; 
            loadSettingsForCart();
        }
    } catch (error) { 
        if(statusText) statusText.innerText = "Online (Local)"; 
        if(loginStatus) loginStatus.innerText = "Status: Sync Failed ⚠️"; 
        const dot = document.getElementById("network-dot"); if(dot) dot.style.backgroundColor = "#f39c12"; 
    }
}

// ---------------------------------------------------------
// DECENTRALIZED VOID AFTERMATH ENGINE
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
        fetch(API_URL, { method: "POST", body: JSON.stringify({ action: "executeVoidAftermath", data: { orderId: order.orderId, customerPhone: order.customerPhone, amount: order.grandTotal, itemsToReturn: itemsToReturn } }) }).catch(e => console.log(e));
    }
}

// ---------------------------------------------------------
// MENU & PRODUCT UI
// ---------------------------------------------------------
function loadMenuUI() {
    const store = db.transaction(["menu"], "readonly").objectStore("menu");
    store.getAll().onsuccess = (e) => {
        globalMenuData = e.target.result;
        if (globalMenuData.length === 0) return;
        const categories = [...new Set(globalMenuData.map(item => item.category))];
        currentCategory = categories[0]; 

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
            stockP.style.color = isOutOfStock ? "#e74c3c" : "#2980b9"; stockP.innerText = `Stock: ${item.currentStock}`; infoDiv.appendChild(stockP);
        }
        card.appendChild(infoDiv);

        const actionsDiv = document.createElement("div"); actionsDiv.className = "product-actions";
        if (isOutOfStock) {
            const btnOut = document.createElement("button"); btnOut.className = "btn-add"; btnOut.innerText = "Out of Stock";
            btnOut.style.backgroundColor = "#e74c3c"; btnOut.style.color = "white"; btnOut.style.cursor = "not-allowed"; btnOut.disabled = true; actionsDiv.appendChild(btnOut);
        } else if (halfPrice > 0) {
            const btnHalf = document.createElement("button"); btnHalf.className = "btn-add"; btnHalf.innerText = "½"; btnHalf.onclick = () => addItemToCart(item, 0.5, halfPrice);
            const btnFull = document.createElement("button"); btnFull.className = "btn-add"; btnFull.innerText = "1"; btnFull.onclick = () => addItemToCart(item, 1, fullPrice);
            actionsDiv.appendChild(btnHalf); actionsDiv.appendChild(btnFull);
        } else {
            const btnAdd = document.createElement("button"); btnAdd.className = "btn-add"; btnAdd.innerText = "+ Add"; btnAdd.onclick = () => addItemToCart(item, 1, fullPrice);
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
    const addBtn = document.createElement("button"); addBtn.className = "cust-tab"; addBtn.innerText = "+ Add Table"; addBtn.onclick = openAddTableModal;
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
    activeOrders.push({ name: `Table ${tablePrefix}${nextTableNumber}`, customerName: name, customerPhone: phone || "Walk-in", plates: [{ plateId: 1, items: [] }] });
    nextTableNumber++; currentOrderIndex = activeOrders.length - 1; activePlateIndex = 0;
    preserveUnpaidTables(); closeAddTableModal(); renderCustomerTabs(); renderCartUI(); runBackgroundSync();
}

function loadSettingsForCart() {
    db.transaction(["settings"], "readonly").objectStore("settings").get("Tax_Rate_Percent").onsuccess = (e) => {
        if (e.target.result && e.target.result.value) taxRatePercent = parseFloat(e.target.result.value);
    };
}

function addItemToCart(item, portionType, basePrice) {
    if (activeOrders.length === 0) return alert("Please open a table first by clicking '+ Add Table'!");
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
        container.innerHTML = `<div style="text-align:center; padding:40px; color:#7f8c8d; font-size:16px;">No active tables.</div>`;
        document.getElementById("cart-subtotal").innerText = "Rp 0"; document.getElementById("cart-tax").innerText = "Rp 0"; document.getElementById("cart-total").innerText = "Rp 0";
        return;
    }
    let subtotal = 0; const currentOrder = activeOrders[currentOrderIndex];
    currentOrder.plates.forEach((plate, index) => {
        const plateBox = document.createElement("div"); plateBox.className = "plate-box";
        if (index === activePlateIndex) { plateBox.style.borderColor = "#2ecc71"; plateBox.style.borderStyle = "solid"; }
        
        let itemsHtml = "";
        if (plate.items.length === 0) itemsHtml = `<div style="color:#7f8c8d; font-size:14px; text-align:center; margin-top:10px;">Cart is empty</div>`;
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
        plateBox.innerHTML = `<div class="plate-header"><span>Plate ${plate.plateId} ${index === activePlateIndex ? '🟢' : ''}</span><button class="btn-new-plate" onclick="addNewPlate()">+ New Plate</button></div>${itemsHtml}`;
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
    if (confirm("Are you sure you want to clear this table's order?")) { activeOrders[currentOrderIndex].plates = [{ plateId: 1, items: [] }]; preserveUnpaidTables(); renderCartUI(); }
}

function reviewOrder() {
    if (activeOrders.length === 0) return;
    const currentOrder = activeOrders[currentOrderIndex];
    let hasItems = false; currentOrder.plates.forEach(p => { if (p.items.length > 0) hasItems = true; });
    if (!hasItems) return alert("This table's cart is empty!");

    let receiptHtml = "";
    currentOrder.plates.forEach(plate => {
        if(plate.items.length > 0) {
            receiptHtml += `<div style="font-weight:bold; margin-top:10px;">Plate ${plate.plateId}</div>`;
            plate.items.forEach(item => {
                const itemTotal = item.originalPrice * item.qty;
                receiptHtml += `<div style="display:flex; justify-content:space-between; margin-left:10px; padding: 2px 0;"><span>${item.qty}x ${item.name}</span><span>Rp ${itemTotal.toLocaleString('id-ID')}</span></div>`;
            });
        }
    });
    document.getElementById("review-receipt-items").innerHTML = receiptHtml;

    const list = document.getElementById("promo-list"); list.innerHTML = "";
    db.transaction(["promo_codes"], "readonly").objectStore("promo_codes").getAll().onsuccess = (e) => {
        e.target.result.forEach(promo => { const opt = document.createElement("option"); opt.value = promo.code; opt.innerText = `${promo.discountPercent}% Off`; list.appendChild(opt); });
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

    if (totalPaid < totals.grandTotal) if (!confirm("Warning: Amount paid is less than Grand Total. Proceed anyway?")) return;
    const orderId = "ORD-" + Date.now();
    const finalStatus = shouldPrint ? "Paid" : "Paid but not printed";

    if (shouldPrint) { await buildPrintableReceipt(orderId, currentOrder, totals, cashPaid, qrisPaid, changeDue); window.print(); } 
    else if (changeDue > 0) { alert(`Payment Success!\nChange due: Rp ${changeDue.toLocaleString('id-ID')}`); }

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
    const footer1 = settings["Footer_1"] || "THANK YOU!"; const footer2 = settings["Footer_2"] || "Please come again"; const footer3 = settings["Footer_3"] || ""; 
    const printArea = document.getElementById("printable-area"); const dateStr = new Date().toLocaleString('id-ID');
    
    let itemsHtml = "";
    order.plates.forEach(plate => {
        if(plate.items.length > 0) {
            itemsHtml += `<div style="font-weight:bold; margin-top:8px;">Plate ${plate.plateId}</div>`;
            plate.items.forEach(item => { 
                const lineTotal = item.qty * item.originalPrice;
                itemsHtml += `<div style="display:flex; justify-content:space-between; margin-bottom: 2px;"><span>${item.qty}x ${item.name}</span><span>${lineTotal.toLocaleString('id-ID')}</span></div>`; 
            });
        }
    });

    let discountHtml = totals.totalSavings > 0 ? `<div style="display:flex; justify-content:space-between;"><span>Total Discount:</span><span>-Rp ${totals.totalSavings.toLocaleString('id-ID')}</span></div>` : "";
    let promoHtml = totals.promoName ? `<div style="display:flex; justify-content:space-between; font-size:10px; color:#555;"><span>(Promo Applied:</span><span>${totals.promoName})</span></div>` : "";

    printArea.innerHTML = `
        <div style="text-align:center; margin-bottom:10px;"><h2 style="margin:0;">${storeName}</h2><div style="font-size:10px;">${storeAddress}</div><div style="font-size:10px;">${dateStr}</div></div>
        <div style="border-top:1px dashed #000; border-bottom:1px dashed #000; padding:5px 0; margin-bottom:5px; font-size: 11px;">
            <div>Order: ${orderId}</div><div>Table: ${order.name}</div><div>Customer: ${order.customerName}</div><div>Cashier: ${currentCashier}</div>
        </div>
        ${itemsHtml}
        <div style="border-top:1px dashed #000; margin-top:10px; padding-top:5px;">
            <div style="display:flex; justify-content:space-between;"><span>Subtotal:</span><span>Rp ${totals.baseSubtotal.toLocaleString('id-ID')}</span></div>
            ${discountHtml}${promoHtml}
            <div style="display:flex; justify-content:space-between;"><span>Tax:</span><span>Rp ${totals.taxAmount.toLocaleString('id-ID')}</span></div>
            <div style="display:flex; justify-content:space-between; font-weight:bold; font-size:14px; margin-top:5px; border-bottom: 1px solid #000; padding-bottom: 5px;"><span>TOTAL:</span><span>Rp ${totals.grandTotal.toLocaleString('id-ID')}</span></div>
        </div>
        <div style="margin-top:5px; font-size:11px;">
            ${cash > 0 ? `<div style="display:flex; justify-content:space-between;"><span>Cash Paid:</span><span>Rp ${cash.toLocaleString('id-ID')}</span></div>` : ''}
            ${qris > 0 ? `<div style="display:flex; justify-content:space-between;"><span>QRIS Paid:</span><span>Rp ${qris.toLocaleString('id-ID')}</span></div>` : ''}
            ${changeDue > 0 ? `<div style="display:flex; justify-content:space-between; font-weight:bold; margin-top: 5px;"><span>CHANGE:</span><span>Rp ${changeDue.toLocaleString('id-ID')}</span></div>` : ''}
        </div>
        <div style="text-align:center; margin-top:15px; font-weight:bold; font-size: 12px;">${footer1}</div>
        <div style="text-align:center; margin-top:2px; font-size: 10px;">${footer2}</div>
        ${footer3 ? `<div style="text-align:center; margin-top:2px; font-size: 10px;">${footer3}</div>` : ''}
    `;
}

// ---------------------------------------------------------
// CONTINUOUS DRAWER ENGINE (MONEY JOURNAL)
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

function openCashDrop(forLogout = false) {
    isLoggingOut = forLogout;
    if (isLoggingOut) {
        document.getElementById("cash-drop-title").innerText = "🔒 End of Shift Cash Log";
        document.getElementById("btn-drop-cancel").innerText = "Cancel Logout";
        document.getElementById("btn-drop-confirm").innerText = "Confirm & Logout";
    } else {
        document.getElementById("cash-drop-title").innerText = "🏦 Store Money";
        document.getElementById("btn-drop-cancel").innerText = "Cancel";
        document.getElementById("btn-drop-confirm").innerText = "Save Record";
    }
    
    document.getElementById("drop-admin").value = 0; document.getElementById("drop-bank").value = 0; document.getElementById("drop-notes").value = "";
    
    calculateLiveDrawer((liveAmount) => {
        document.getElementById("live-drawer-display").innerText = `Rp ${liveAmount.toLocaleString('id-ID')}`;
        document.getElementById("cash-drop-modal").classList.remove("hidden");
    });
}

function closeCashDrop() { document.getElementById("cash-drop-modal").classList.add("hidden"); isLoggingOut = false; }

function submitCashDrop() {
    const adminAmt = Number(document.getElementById("drop-admin").value) || 0;
    const bankAmt = Number(document.getElementById("drop-bank").value) || 0;
    const notes = document.getElementById("drop-notes").value || (isLoggingOut ? "Shift End" : "Mid-shift Drop");
    
    calculateLiveDrawer((liveAmount) => {
        const leftInDrawer = liveAmount - adminAmt - bankAmt;
        
        const payload = {
            dropId: "DRP-" + Date.now(), timestamp: new Date().toISOString(), cashier: currentCashier, shiftId: currentShiftId,
            toAdmin: adminAmt, toBank: bankAmt, leftInDrawer: leftInDrawer, notes: notes, syncStatus: "Pending"
        };
        
        db.transaction(["cash_drops"], "readwrite").objectStore("cash_drops").add(payload);
        closeCashDrop(); runBackgroundSync();
        
        if (isLoggingOut) { executeFinalLogout(leftInDrawer); } 
        else { alert(`Cash Drop Logged!\nLeft in Drawer: Rp ${leftInDrawer.toLocaleString('id-ID')}`); }
    });
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
            if(shiftOrders.length === 0) return container.innerHTML = `<div style="padding:20px; text-align:center;">No orders logged inside the current shift.</div>`;
            shiftOrders.forEach(o => {
                let badge = o.orderStatus === "Voided" ? `<span class="status-badge status-voided">Voided</span>` :
                            o.orderStatus === "Void Pending" ? `<span class="status-badge status-pending">Waiting for Admin</span>` :
                            `<span class="status-badge status-paid">${o.orderStatus}</span>`; 
                let btn = (o.orderStatus === "Paid" || o.orderStatus === "Paid but not printed") ? `<button onclick="requestVoid('orders', '${o.orderId}')" style="background:#e74c3c; color:white; border:none; padding:5px 10px; border-radius:4px; cursor:pointer;">Void</button>` : '';
                container.innerHTML += `<div class="history-row"><div><strong>${o.tablePrefix} (${o.customerName})</strong><br><small style="color:#7f8c8d;">${new Date(o.timestamp).toLocaleTimeString()} | Rp ${o.grandTotal.toLocaleString('id-ID')}</small></div><div style="display:flex; align-items:center; gap:10px;">${badge} ${btn}</div></div>`;
            });
        };
    } else if (type === 'expenses') {
        db.transaction(["expenses"], "readonly").objectStore("expenses").getAll().onsuccess = (e) => {
            const shiftExpenses = e.target.result.filter(exp => exp.shiftId === currentShiftId).reverse();
            if(shiftExpenses.length === 0) return container.innerHTML = `<div style="padding:20px; text-align:center;">No expenses logged inside the current shift.</div>`;
            shiftExpenses.forEach(exp => {
                let badge = exp.status === "Voided" ? `<span class="status-badge status-voided">Voided</span>` :
                            exp.status === "Void Pending" ? `<span class="status-badge status-pending">Waiting for Admin</span>` :
                            `<span class="status-badge status-paid">Active</span>`;
                let btn = exp.status !== "Voided" && exp.status !== "Void Pending" ? `<button onclick="requestVoid('expenses', '${exp.expenseId}')" style="background:#e74c3c; color:white; border:none; padding:5px 10px; border-radius:4px; cursor:pointer;">Void</button>` : '';
                container.innerHTML += `<div class="history-row"><div><strong>${exp.category}</strong><br><small style="color:#7f8c8d;">${new Date(exp.timestamp).toLocaleTimeString()} | Rp ${exp.amount.toLocaleString('id-ID')}</small><br><small>${exp.description}</small></div><div style="display:flex; align-items:center; gap:10px;">${badge} ${btn}</div></div>`;
            });
        };
    } else if (type === 'shifts') {
        db.transaction(["local_shift_history"], "readonly").objectStore("local_shift_history").getAll().onsuccess = (e) => {
            const shifts = e.target.result.reverse();
            if(shifts.length === 0) return container.innerHTML = `<div style="padding:20px; text-align:center;">No past shifts recorded on this device yet.</div>`;
            shifts.forEach(s => {
                container.innerHTML += `
                    <div class="history-row">
                        <div><strong>${s.shiftId} (${s.cashier})</strong><br><small style="color:#7f8c8d;">Logout: ${new Date(s.logoutTime).toLocaleString('id-ID')}</small></div>
                        <button onclick="viewPastShift('${s.shiftId}')" style="background:#3498db; color:white; border:none; padding:5px 10px; border-radius:4px; cursor:pointer;">View Report</button>
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
    const pin = document.getElementById("admin-void-pin").value; if (!pin) return alert("Please enter a PIN.");
    const settings = await getDynamicSettings(); const masterPin = String(settings["Master_PIN"]); const isMaster = (pin === masterPin);
    
    db.transaction(["staff"], "readonly").objectStore("staff").get(pin).onsuccess = (e) => {
        const staff = e.target.result; const isAdmin = (staff && staff.role.toLowerCase() === 'admin');

        if (isMaster || isAdmin) {
            const authName = isMaster ? "Master Admin" : staff.name;
            const type = currentVoidTarget.type; const id = currentVoidTarget.id; const storeName = type === 'orders' ? "orders" : "expenses";
            
            db.transaction([storeName], "readwrite").objectStore(storeName).get(id).onsuccess = (ev) => {
                const item = ev.target.result;
                if (type === 'orders') { item.orderStatus = "Voided"; item.voidAuth = authName; applyVoidAftermath(item); } 
                else { item.status = "Voided"; item.voidAuth = authName; }
                item.syncStatus = "Pending"; db.transaction([storeName], "readwrite").objectStore(storeName).put(item); renderHistoryList(type);
            };
            
            db.transaction(["void_requests"], "readwrite").objectStore("void_requests").add({ id: id, type: type, status: "Voided", authName: authName });
            closeAdminVoidModal(); runBackgroundSync(); alert("Transaction instantly voided by: " + authName);
        } else { alert("Invalid PIN or you do not have Admin privileges."); }
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
    document.getElementById("shift-customers").innerText = s.totalCustomers; 
    document.getElementById("shift-plates").innerText = s.totalPlates;
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
        net: Number(String(s.netCash).replace(/[^\d.-]/g, '')), foodSummary: s.foodSummary, foodStr: foodStr
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
            totalCash += o.cashAmount; totalQris += o.qrisAmount; totalOmset += o.grandTotal;
            o.plates.forEach(p => p.items.forEach(i => { if(!foodSummary[i.name]) foodSummary[i.name] = 0; foodSummary[i.name] += i.qty; }));
        });

        db.transaction(["expenses"], "readonly").objectStore("expenses").getAll().onsuccess = (e2) => {
            const validExp = e2.target.result.filter(exp => exp.shiftId === currentShiftId && exp.status !== "Voided" && exp.status !== "Void Pending");
            validExp.forEach(exp => { totalExpenses += exp.amount; });

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

    const printShiftId = data.isPast ? data.shiftId : currentShiftId; const printCashier = data.isPast ? data.cashier : currentCashier;

    printArea.innerHTML = `
        <div style="text-align:center; margin-bottom:10px;"><h2 style="margin:0;">${storeName}</h2><div style="font-size:10px;">${storeAddress}</div><div style="font-size:10px;">${dateStr}</div></div>
        <div style="border-top:1px dashed #000; border-bottom:1px dashed #000; padding:5px 0; margin-bottom:10px; font-size: 14px; text-align:center; font-weight:bold;">SHIFT REPORT</div>
        <div style="font-size: 11px; margin-bottom:10px;">
            <div>Shift ID: ${printShiftId}</div><div>Cashier: ${printCashier}</div><div>Customers: ${data.totalCustomers}</div><div>Plates Used: ${data.totalPlates}</div>
        </div>
        <div style="border-bottom:1px dashed #000; margin-bottom:5px; font-weight:bold;">FINANCIALS</div>
        <div style="display:flex; justify-content:space-between;"><span>Gross Omset:</span><span>Rp ${data.totalOmset.toLocaleString('id-ID')}</span></div>
        <div style="display:flex; justify-content:space-between;"><span>QRIS Received:</span><span>Rp ${data.totalQris.toLocaleString('id-ID')}</span></div>
        <div style="display:flex; justify-content:space-between; margin-top:5px; font-weight:bold;"><span>Cash Received:</span><span>Rp ${data.totalCash.toLocaleString('id-ID')}</span></div>
        <div style="display:flex; justify-content:space-between; color:#e74c3c;"><span>Expenses Paid:</span><span>-Rp ${data.totalExpenses.toLocaleString('id-ID')}</span></div>
        <div style="display:flex; justify-content:space-between; font-weight:bold; font-size:14px; margin-top:5px; border-top: 1px solid #000; padding-top: 5px;"><span>CASH IN DRAWER:</span><span>Rp ${data.net.toLocaleString('id-ID')}</span></div>
        <div style="border-bottom:1px dashed #000; margin-top:15px; margin-bottom:5px; font-weight:bold;">ITEMS SOLD</div><div style="font-size:11px; text-align:left; white-space:pre-wrap;">${data.foodStr}</div>
        <div style="text-align:center; margin-top:20px; font-weight:bold; font-size: 12px;">END OF REPORT</div>
    `;
    window.print();
}

function closeShiftReport() { document.getElementById("shift-report-modal").classList.add("hidden"); }

function initiateLogoutSequence() { 
    document.getElementById("shift-report-modal").classList.add("hidden"); 
    openCashDrop(true); 
}

// DECOUPLED FROM NETWORK - INSTANT WIPE & RELOAD
function executeFinalLogout(netCash) { 
    const data = window.currentShiftData;
    const shiftPayload = {
        shiftId: currentShiftId, timestamp: new Date().toISOString(), cashier: currentCashier, loginTime: currentLoginTime, logoutTime: new Date().toISOString(), 
        totalCustomers: data.totalCustomers, totalPlates: data.totalPlates, totalOmset: data.totalOmset, totalCash: data.totalCash, totalQris: data.totalQris, totalExpenses: data.totalExpenses, netCash: netCash,
        foodSummary: data.foodSummary, syncStatus: "Pending"
    };

    // 1. INSTANT LOCAL SAVE: No waiting, no promises hanging
    const tx = db.transaction(["local_shift_history", "shift_reports", "active_shifts"], "readwrite");
    tx.objectStore("local_shift_history").add(shiftPayload);
    tx.objectStore("shift_reports").add(shiftPayload);
    tx.objectStore("active_shifts").delete(currentPin); 

    localStorage.removeItem(`unpaid_cache_${currentShiftId}`); 
    localStorage.removeItem("pos_active_session"); 

    // 2. NETWORK PUSH (SILENT): Do not block the UI waiting for Google!
    if (navigator.onLine) {
        fetch(API_URL, { method: "POST", body: JSON.stringify({ action: "syncShiftReport", data: shiftPayload }) })
        .then(res => res.json())
        .then(json => {
            if (json.status === "Success") {
                db.transaction(["shift_reports"], "readwrite").objectStore("shift_reports").delete(shiftPayload.shiftId);
            }
        }).catch(e => console.log("Offline logout, saved locally."));
    }
    
    // 3. INSTANT WIPE & RELOAD
    document.getElementById("pos-screen").classList.add("hidden");
    document.getElementById("login-screen").classList.remove("hidden");
    window.location.reload(); 
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
    if (amount <= 0 || !category) return alert("Please enter a valid amount and category.");
    db.transaction(["expense_categories"], "readwrite").objectStore("expense_categories").put({ name: category });

    const payload = { expenseId: "EXP-" + Date.now(), timestamp: new Date().toISOString(), cashier: currentCashier, shiftId: currentShiftId, category: category, description: document.getElementById("exp-desc").value || "-", amount: amount, status: "Active", syncStatus: "Pending" };
    db.transaction(["expenses"], "readwrite").objectStore("expenses").add(payload);
    closeExpenseModal(); document.getElementById("exp-amount").value = ""; document.getElementById("exp-category").value = ""; document.getElementById("exp-desc").value = ""; alert("Expense Recorded!"); runBackgroundSync();
}

function openSettings() { document.getElementById("settings-modal").classList.remove("hidden"); }
function closeSettings() { document.getElementById("settings-modal").classList.add("hidden"); }

// ---------------------------------------------------------
// BACKGROUND SYNC ENGINE (Softened Error Catching)
// ---------------------------------------------------------
let isSyncing = false; 

async function runBackgroundSync() {
    if (!navigator.onLine || isSyncing) return; 
    isSyncing = true;
    try {
        let tx = db.transaction(["orders", "cash_drops", "shift_reports", "expenses", "void_requests", "unsynced_members"], "readonly");
        
        let orders = await new Promise(res => tx.objectStore("orders").getAll().onsuccess = e => res(e.target.result));
        for (const order of orders) {
            if (order.syncStatus === "Pending") {
                order.syncStatus = "Syncing"; db.transaction(["orders"], "readwrite").objectStore("orders").put(order);
                try { let r = await fetch(API_URL, { method: "POST", body: JSON.stringify({ action: "syncOrder", data: order }) }); if ((await r.json()).status === "Success") { order.syncStatus = "Synced"; db.transaction(["orders"], "readwrite").objectStore("orders").put(order); } else { order.syncStatus = "Pending"; db.transaction(["orders"], "readwrite").objectStore("orders").put(order); } } catch(e) { order.syncStatus = "Pending"; db.transaction(["orders"], "readwrite").objectStore("orders").put(order); }
            }
        }

        let expenses = await new Promise(res => tx.objectStore("expenses").getAll().onsuccess = e => res(e.target.result));
        for (const exp of expenses) {
            if (exp.syncStatus === "Pending") {
                try { let r = await fetch(API_URL, { method: "POST", body: JSON.stringify({ action: "syncExpense", data: exp }) }); if ((await r.json()).status === "Success") { exp.syncStatus = "Synced"; db.transaction(["expenses"], "readwrite").objectStore("expenses").put(exp); } } catch(e) {}
            }
        }

        let drops = await new Promise(res => tx.objectStore("cash_drops").getAll().onsuccess = e => res(e.target.result));
        for (const drop of drops) {
            if (drop.syncStatus === "Pending") {
                try { let r = await fetch(API_URL, { method: "POST", body: JSON.stringify({ action: "syncCashDrop", data: drop }) }); if ((await r.json()).status === "Success") { drop.syncStatus = "Synced"; db.transaction(["cash_drops"], "readwrite").objectStore("cash_drops").put(drop); } } catch(e) {}
            }
        }

        let voids = await new Promise(res => tx.objectStore("void_requests").getAll().onsuccess = e => res(e.target.result));
        for (const req of voids) {
            try {
                const actionType = req.type === 'orders' ? "requestOrderVoid" : "requestExpenseVoid"; const payload = req.type === 'orders' ? { orderId: req.id, status: req.status, authName: req.authName } : { expenseId: req.id, status: req.status, authName: req.authName };
                let r = await fetch(API_URL, { method: "POST", body: JSON.stringify({ action: actionType, ...payload }) }); if ((await r.json()).status === "Success") { db.transaction(["void_requests"], "readwrite").objectStore("void_requests").delete(req.id); }
            } catch(e) {}
        }

        let reports = await new Promise(res => tx.objectStore("shift_reports").getAll().onsuccess = e => res(e.target.result));
        for (const report of reports) {
            if (report.syncStatus === "Pending") {
                try { let r = await fetch(API_URL, { method: "POST", body: JSON.stringify({ action: "syncShiftReport", data: report }) }); if ((await r.json()).status === "Success") { db.transaction(["shift_reports"], "readwrite").objectStore("shift_reports").delete(report.shiftId); } } catch(e) {}
            }
        }
        
        let members = await new Promise(res => tx.objectStore("unsynced_members").getAll().onsuccess = e => res(e.target.result));
        for (const mem of members) {
            try { let r = await fetch(API_URL, { method: "POST", body: JSON.stringify({ action: "syncMember", data: mem }) }); if ((await r.json()).status === "Success") { db.transaction(["unsynced_members"], "readwrite").objectStore("unsynced_members").delete(mem.phone); } } catch(e) {}
        }
        syncMasterData();
    } finally {
        isSyncing = false;
    }
}

window.onload = async () => { await initDB(); await syncMasterData(); loadSettingsForCart(); checkActiveSession(); window.setInterval(runBackgroundSync, 15000); };
