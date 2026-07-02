const API_URL = "https://script.google.com/macros/s/AKfycbwskNqcaVKcJ1hhx8Ur3-3AZhPhf1xwtaewqO9vBd8E9Ctv1ev-Mj4x4hJ2y2-3Irmgnw/exec";
const DB_NAME = "HotelPOS_Local_DB";
const DB_VERSION = 38; 
let db;
let antreans = [
  { cart: [], isLocked: true, roomInput: "" },
  { cart: [], isLocked: true, roomInput: "" },
  { cart: [], isLocked: true, roomInput: "" }
];
let currentAntreanIndex = 0;
let currentCashier = ""; let currentPin = ""; let currentShiftId = ""; let currentLoginTime = "";
let globalMenuData = []; let activeLaundryTickets = [];
let currentLocation = ""; let currentSubCategory = "";
let currentCart = []; let activeNumpadItem = null; let numpadValue = "0";
let activeSettlementTicket = null; window.masterDrawerBalance = 0; let isLoggingOut = false;
let isMenuLocked = true; let isSyncing = false; 
window.enableDrawerTracking = true;
let btDevice = null; let btCharacteristic = null;
window.lastActivityWrite = Date.now();

async function hashString(str) {
  const msgUint8 = new TextEncoder().encode(str);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function formatWIB(dateString) { 
  return new Date(dateString).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(',', '') + ' WIB';
}

function formatTimeOnlyWIB(dateString) { 
  return new Date(dateString).toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false, hour: '2-digit', minute: '2-digit' }) + ' WIB'; 
}

let deferredPrompt;
window.addEventListener('beforeinstallprompt', (e) => { 
  e.preventDefault(); 
  deferredPrompt = e; 
  const installBtn = document.getElementById('btn-install'); 
  if(installBtn) installBtn.classList.remove('hidden'); 
});

function installPWA() { 
  if (deferredPrompt) { 
    deferredPrompt.prompt(); 
    deferredPrompt.userChoice.then((choiceResult) => { 
      if (choiceResult.outcome === 'accepted') document.getElementById('btn-install').classList.add('hidden'); 
      deferredPrompt = null; 
    });
  } 
}

function initDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      db = event.target.result;
      if (!db.objectStoreNames.contains("staff")) db.createObjectStore("staff", { keyPath: "pin" });
      if (!db.objectStoreNames.contains("menu")) db.createObjectStore("menu", { keyPath: "itemId" });
      if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings", { keyPath: "key" });
      if (!db.objectStoreNames.contains("orders")) db.createObjectStore("orders", { keyPath: "orderId" });
      if (!db.objectStoreNames.contains("active_shifts")) db.createObjectStore("active_shifts", { keyPath: "pin" });
      if (!db.objectStoreNames.contains("cash_drops")) db.createObjectStore("cash_drops", { keyPath: "dropId" });
      if (!db.objectStoreNames.contains("shift_reports")) db.createObjectStore("shift_reports", { keyPath: "shiftId" });
      if (!db.objectStoreNames.contains("expenses")) db.createObjectStore("expenses", { keyPath: "expenseId" });
      if (!db.objectStoreNames.contains("expense_categories")) db.createObjectStore("expense_categories", { keyPath: "name" });
    };
    request.onsuccess = (e) => { 
      db = e.target.result; 
      db.onversionchange = () => { db.close(); window.location.reload(); }; 
      resolve(db); 
    };
    request.onerror = (e) => { reject(e); };
    request.onblocked = () => { alert("⚠️ Mohon TUTUP tab aplikasi POS yang lain agar sistem bisa diperbarui!"); };
  });
}

function getDynamicSettings() {
  return new Promise((resolve) => {
    let settings = {};
    db.transaction(["settings"], "readonly").objectStore("settings").getAll().onsuccess = (e) => {
      if (e.target.result) { e.target.result.forEach(s => { settings[s.key] = s.value; }); }
      resolve(settings);
    };
  });
}

async function connectBluetoothPrinter() {
  try {
    btDevice = await navigator.bluetooth.requestDevice({ filters: [{ services: [0x18F0] }], optionalServices: [0x18F0] });
    const server = await btDevice.gatt.connect();
    const service = await server.getPrimaryService(0x18F0);
    btCharacteristic = await service.getCharacteristic(0x2AF1);
    const btn = document.getElementById("btn-printer");
    if(btn) { btn.innerText = "🖨️ Printer: Connected"; btn.style.background = "#2ecc71"; btn.style.borderColor = "#2ecc71"; }
  } catch (err) { alert("Gagal terhubung ke printer Bluetooth."); }
}

async function sendToPrinter(payloadUint8) {
  if (!btCharacteristic) { alert("Printer belum terhubung!"); return; }
  const chunkSize = 20;
  for (let i = 0; i < payloadUint8.length; i += chunkSize) {
    const chunk = payloadUint8.slice(i, i + chunkSize);
    await btCharacteristic.writeValue(chunk);
    await new Promise(r => setTimeout(r, 10));
  }
}

function formatEscPosLine(left, right, isBig) {
  const maxLen = isBig ? 16 : 32;
  const leftStr = String(left); const rightStr = String(right);
  const spaceNeeded = maxLen - (leftStr.length + rightStr.length);
  if (spaceNeeded > 0) return leftStr + " ".repeat(spaceNeeded) + rightStr;
  const paddingNeeded = maxLen - rightStr.length;
  return leftStr + "\n" + (paddingNeeded > 0 ? " ".repeat(paddingNeeded) : "") + rightStr;
}

function logUserActivity() {
  let now = Date.now();
  if (currentPin && (now - window.lastActivityWrite > 5 * 60 * 1000)) {
    window.lastActivityWrite = now;
    let tx = db.transaction(["active_shifts"], "readwrite");
    let store = tx.objectStore("active_shifts");
    store.get(currentPin).onsuccess = (e) => {
      let shift = e.target.result;
      if (shift) { shift.lastActiveTime = now; store.put(shift); }
    };
  }
}
['click', 'touchstart', 'mousemove', 'keydown'].forEach(evt => { window.addEventListener(evt, logUserActivity, { passive: true }); });

async function buildEscPosReceipt(orderId, order, deposit, payMethod) {
  const settings = await getDynamicSettings();
  const h1 = settings["Header_1"] || "HOTEL POS ENGINE"; 
  const h2 = settings["Header_2"] || "F&B AND SERVICES"; 
  const h3 = settings["Header_3"] || "";
  const f1 = settings["Footer_1"] || "TERIMA KASIH"; 
  const f2 = settings["Footer_2"] || ""; 
  const f3 = settings["Footer_3"] || "";

  let receipt = "\x1B\x40\x1B\x61\x01\x1B\x45\x01\x1B!\x11" + h1 + "\n\x1B!\x00\x1B\x45\x00";
  if(h2) receipt += h2 + "\n"; if(h3) receipt += h3 + "\n";
  receipt += formatWIB(order.timestamp || new Date().toISOString()) + "\n--------------------------------\n\x1B\x61\x00";
  receipt += "Nota: " + orderId + "\nKmr : " + (order.roomNumber || "-") + "\nPlgn: " + order.customerName + "\nKsr : " + order.cashier + "\n--------------------------------\n";
  
  order.items.forEach(item => {
    const qtyDisplay = item.qty % 1 !== 0 ? item.qty.toFixed(2) : item.qty;
    const lineTotal = (item.qty * item.price).toLocaleString('id-ID');
    receipt += formatEscPosLine(`${qtyDisplay}x ${item.name.substring(0,18)}`, lineTotal, false) + "\n";
  });
  
  receipt += "--------------------------------\n" + formatEscPosLine("Subtotal", order.subtotal.toLocaleString('id-ID'), false) + "\n";
  if (order.discounts && order.discounts > 0) receipt += formatEscPosLine("Total Diskon", "-" + order.discounts.toLocaleString('id-ID'), false) + "\n";
  receipt += "\x1B\x45\x01\x1B!\x11" + formatEscPosLine("TOTAL", order.grandTotal.toLocaleString('id-ID'), true) + "\n\x1B!\x00\x1B\x45\x00\n";
  receipt += formatEscPosLine(`Bayar (${payMethod})`, deposit.toLocaleString('id-ID'), false) + "\n";
  
  let piutangCount = (order.hotelPiutangAmount || 0) + (order.tamuPiutangAmount || 0);
  receipt += "\x1B\x45\x01" + (piutangCount > 0 ? formatEscPosLine("TOTAL PIUTANG", piutangCount.toLocaleString('id-ID'), false) : formatEscPosLine("STATUS", "LUNAS", false)) + "\x1B\x45\x00\n--------------------------------\n\x1B\x61\x01\x1B\x45\x01" + f1 + "\n\x1B\x45\x00";
  if(f2) receipt += f2 + "\n"; if(f3) receipt += f3 + "\n";
  receipt += "\n\n\n\n\x1D\x56\x41\x10";
  await sendToPrinter(new TextEncoder().encode(receipt));
}

async function buildShiftReportReceipt(data) {
  let r = "\x1B\x40\x1B\x61\x01\x1B\x45\x01\x1B!\x11HOTEL POS\n\x1B!\x00\x1B\x45\x00LAPORAN TUTUP SHIFT\n--------------------------------\n\x1B\x61\x00";
  r += "ID Shift: " + data.shiftId + "\nKasir   : " + data.cashier + "\nLogin   : " + formatTimeOnlyWIB(data.loginTime) + "\nLogout  : " + formatTimeOnlyWIB(data.logoutTime) + "\n--------------------------------\n";
  r += formatEscPosLine("Total Nota", data.totalOrders, false) + "\n" + formatEscPosLine("Total Pelanggan", data.totalCustomers, false) + "\n--------------------------------\n\x1B\x45\x01PENERIMAAN KASIR:\x1B\x45\x00\n";
  
  r += formatEscPosLine("Cash (Laundry)", (data.totalCashLaundry||0).toLocaleString('id-ID'), false) + "\n" + 
       formatEscPosLine("Cash (Hotel)", (data.totalCashHotel||0).toLocaleString('id-ID'), false) + "\n" + 
       formatEscPosLine("QRIS (Lndry)", data.totalQris.toLocaleString('id-ID'), false) + "\n" + 
       formatEscPosLine("Transfr(Htl)", data.totalTransfer.toLocaleString('id-ID'), false) + "\n--------------------------------\n\x1B\x45\x01PENGELUARAN:\x1B\x45\x00\n";
  
  r += formatEscPosLine("Pengeluaran Laci", data.totalExpenses.toLocaleString('id-ID'), false) + "\n--------------------------------\n\x1B\x45\x01OMSET KOTOR:\x1B\x45\x00\n" + formatEscPosLine("Grand Total", data.totalOmset.toLocaleString('id-ID'), false) + "\n\n";
  r += "\x1B\x45\x01" + formatEscPosLine(window.enableDrawerTracking ? "SALDO LACI" : "SETOR BACKOFFICE", data.netCash.toLocaleString('id-ID'), false) + "\x1B\x45\x00\n";
  
  if (data.structuredFoodSummary) {
    r += "--------------------------------\n\x1B\x61\x01RINGKASAN ITEM TERJUAL\n\x1B\x61\x00";
    for (const loc in data.structuredFoodSummary) {
        r += `\n--- ${loc} ---\n`;
        for (const cat in data.structuredFoodSummary[loc]) {
            for (const itemName in data.structuredFoodSummary[loc][cat]) {
                let qty = data.structuredFoodSummary[loc][cat][itemName];
                let qtyDisplay = qty % 1 !== 0 ? Number(qty).toFixed(2) : String(qty);
                r += formatEscPosLine(`${qtyDisplay}x ${itemName.substring(0,22)}`, "", false) + "\n"; 
            }
        }
    }
  }
  
  r += "\n\n\n\n\x1D\x56\x41\x10";
  await sendToPrinter(new TextEncoder().encode(r));
}

async function attemptLogin() {
    const pinInput = document.getElementById("cashier-pin"); 
    const rawPin = String(pinInput.value).trim(); 
    if (!rawPin) return;
  const loginBtn = document.getElementById("btn-login");
  if (loginBtn) { loginBtn.disabled = true; loginBtn.innerText = "Memverifikasi..."; }
  try {
    const hashedPin = await hashString(rawPin);
    db.transaction(["staff"], "readonly").objectStore("staff").get(hashedPin).onsuccess = async (e) => {
      let staff = e.target.result;
      if (staff) {
        db.transaction(["active_shifts"], "readonly").objectStore("active_shifts").get(hashedPin).onsuccess = (shiftReq) => {
          const activeShift = shiftReq.target.result; currentCashier = staff.name; currentPin = hashedPin;
          if (activeShift) { currentShiftId = activeShift.shiftId; currentLoginTime = activeShift.loginTime; }
          else {
            currentShiftId = "SHF-" + Date.now(); currentLoginTime = new Date().toISOString();
            db.transaction(["active_shifts"], "readwrite").objectStore("active_shifts").put({pin: hashedPin, shiftId: currentShiftId, loginTime: currentLoginTime, lastActiveTime: Date.now(), cashierName: currentCashier});
          }
          document.getElementById("login-screen").classList.add("hidden"); document.getElementById("pos-screen").classList.remove("hidden");
          document.getElementById("display-cashier").innerText = currentCashier; document.getElementById("main-workspace-wrapper").classList.remove("hidden");
          syncMasterData(); lockMenu();
        };
      } else { alert("PIN Salah!"); }
    };
  } catch (err) { alert("Terjadi kesalahan sistem."); } finally { if (loginBtn) { loginBtn.disabled = false; loginBtn.innerText = "Masuk / Buka Shift"; } pinInput.value = ""; }
}

function switchWorkspace(type) {
  document.querySelectorAll('.ws-tab').forEach(b => b.classList.remove('active'));
  document.getElementById("main-workspace-wrapper").classList.add("hidden"); document.getElementById("active-tickets-workspace").classList.add("hidden");
  if (type === 'new') { document.getElementById("tab-new-order").classList.add("active"); document.getElementById("main-workspace-wrapper").classList.remove("hidden"); }
  else { document.getElementById("tab-active-tickets").classList.add("active"); document.getElementById("active-tickets-workspace").classList.remove("hidden"); renderActiveTickets(); }
}

window.switchAntrean = function(index) {
  if (currentAntreanIndex === index) return;
  antreans[currentAntreanIndex].cart = [...currentCart]; 
  antreans[currentAntreanIndex].isLocked = isMenuLocked; 
  if(document.getElementById("cust-room")) antreans[currentAntreanIndex].roomInput = document.getElementById("cust-room").value;
  
  currentAntreanIndex = index;
  currentCart = [...antreans[currentAntreanIndex].cart]; 
  isMenuLocked = antreans[currentAntreanIndex].isLocked; 
  if(document.getElementById("cust-room")) document.getElementById("cust-room").value = antreans[currentAntreanIndex].roomInput;
  
  document.querySelectorAll(".antrean-btn").forEach((btn, i) => {
    if (i === index) { btn.classList.add("active"); btn.style.background = "#fff"; btn.style.color = "#2980b9"; }
    else { btn.classList.remove("active"); btn.style.background = "#bdc3c7"; btn.style.color = "#fff"; }
  });
  
  if (isMenuLocked) {
    document.getElementById("customer-input-section").classList.remove("hidden"); document.getElementById("active-customer-banner").classList.add("hidden");
    document.getElementById("glass-overlay").style.opacity = "1"; document.getElementById("glass-overlay").style.pointerEvents = "auto";
  } else {
    let pRoom = document.getElementById("cust-room").value;
    let pName = (!pRoom || pRoom === "-") ? "Tamu Walk-in / Luar" : `Tamu [Kamar ${pRoom}]`;
    document.getElementById("active-cust-name").innerText = pName; 
    document.getElementById("customer-input-section").classList.add("hidden"); document.getElementById("active-customer-banner").classList.remove("hidden");
    document.getElementById("glass-overlay").style.opacity = "0"; document.getElementById("glass-overlay").style.pointerEvents = "none";
  }
  renderCart();
}

function lockMenu() {
  isMenuLocked = true;
  document.getElementById("customer-input-section").classList.remove("hidden"); document.getElementById("active-customer-banner").classList.add("hidden");
  document.getElementById("glass-overlay").style.opacity = "1"; document.getElementById("glass-overlay").style.pointerEvents = "auto";
  if(document.getElementById("cust-room")) document.getElementById("cust-room").value = ""; 
  
  currentCart = [];
  antreans[currentAntreanIndex].cart = []; antreans[currentAntreanIndex].isLocked = true;
  antreans[currentAntreanIndex].roomInput = "";
  renderCart();
}

function unlockMenu(isGuest) {
  let roomElement = document.getElementById("cust-room");
  let room = roomElement ? roomElement.value : "-";

  let name = "";
  if (isGuest || !room || room === "-") {
    room = "-";
    name = "Tamu Walk-in / Luar";
  } else {
    name = `Tamu [Kamar ${room}]`;
  }
  
  document.getElementById("active-cust-name").innerText = name;
  document.getElementById("customer-input-section").classList.add("hidden"); 
  document.getElementById("active-customer-banner").classList.remove("hidden");
  
  isMenuLocked = false; 
  document.getElementById("glass-overlay").style.opacity = "0";
  setTimeout(() => { document.getElementById("glass-overlay").style.pointerEvents = "none"; }, 300);
  
  antreans[currentAntreanIndex].isLocked = false; 
  antreans[currentAntreanIndex].roomInput = room; 
  renderCart();
}

async function manualPushSync() {
  if (!navigator.onLine) return alert("Anda sedang offline!");
  document.getElementById("network-text").innerText = "Mengirim..."; await runBackgroundSync();
  document.getElementById("network-text").innerText = "Menarik..."; await syncMasterData();
  alert("Sinkronisasi Berhasil!");
}

async function syncMasterData() {
  let netText = document.getElementById("network-text"); let netDot = document.getElementById("network-dot");
  if (!navigator.onLine) { if(netText) netText.innerText = "Offline Mode"; if(netDot) netDot.style.backgroundColor = "#e74c3c"; return; }
  try {
    const response = await fetch(API_URL, { method: 'GET', mode: 'cors' });
    const result = await response.json();
    if (result.status === "Success") {
      window.masterDrawerBalance = result.masterDrawerBalance || 0; 
      window.enableDrawerTracking = String(result.data.settings["Enable_Drawer_Tracking"]).toUpperCase() !== "FALSE";
      
      const tx = db.transaction(["staff", "menu", "settings", "expense_categories", "shift_reports", "cash_drops"], "readwrite");
      tx.objectStore("staff").clear(); 
      result.data.staff.forEach(s => {
          // Force lowercase PIN to fix syncing issues
          s.pin = String(s.pin).toLowerCase();
          tx.objectStore("staff").add(s);
      });
      
      tx.objectStore("menu").clear(); result.data.menu.forEach(m => tx.objectStore("menu").add(m));
      tx.objectStore("expense_categories").clear(); if(result.data.expenseCategories) result.data.expenseCategories.forEach(c => tx.objectStore("expense_categories").add({name: c}));
      tx.objectStore("settings").clear(); for (const [key, value] of Object.entries(result.data.settings)) { tx.objectStore("settings").add({ key: key, value: value }); }
      
      tx.objectStore("shift_reports").clear(); if(result.data.pastShifts) result.data.pastShifts.forEach(sh => tx.objectStore("shift_reports").add(sh));
      tx.objectStore("cash_drops").clear(); if(result.data.pastDrops) result.data.pastDrops.forEach(d => tx.objectStore("cash_drops").add(d));

      globalMenuData = result.data.menu; activeLaundryTickets = result.data.activeLaundryOrders || [];
      if(document.getElementById("ticket-count")) document.getElementById("ticket-count").innerText = activeLaundryTickets.length;
      if(netText) netText.innerText = "Online Synced"; if(netDot) netDot.style.backgroundColor = "#2ecc71";
      if (!document.getElementById("pos-screen").classList.contains("hidden")) { loadMenuUI(); renderActiveTickets(); }
      getDynamicSettings().then(settings => {
          if(settings["Room_List"]) {
              const roomSelect = document.getElementById("cust-room");
              if (roomSelect) {
                  roomSelect.innerHTML = '<option value="">- Pilih Nomor Kamar -</option>';
                  settings["Room_List"].split(",").forEach(r => {
                      let val = r.trim();
                      if(val) roomSelect.innerHTML += `<option value="${val}">${val}</option>`;
                  });
              }
          }
      });
    }
  } catch (e) { if(netText) netText.innerText = "Sync Mismatch"; if(netDot) netDot.style.backgroundColor = "#e74c3c"; }
}

function loadMenuUI() {
  const locations = [...new Set(globalMenuData.map(i => i.location))];
  if (!currentLocation || !locations.includes(currentLocation)) {
      currentLocation = locations[0] || "";
  }
  
  let catContainer = document.getElementById("category-container");
  let locContainer = document.getElementById("location-container");
  
  if (!locContainer && catContainer) {
      locContainer = document.createElement("div");
      locContainer.id = "location-container";
      locContainer.className = "category-tabs";
      locContainer.style.background = "#2c3e50";
      locContainer.style.marginBottom = "5px";
      catContainer.parentNode.insertBefore(locContainer, catContainer);
  }

  if(locContainer) {
      locContainer.innerHTML = "";
      locations.forEach(loc => {
          const btn = document.createElement("button");
          btn.className = `cat-btn ${loc === currentLocation ? "active" : ""}`;
          btn.style.color = loc === currentLocation ? "#fff" : "#2c3e50";
          if (loc === currentLocation) btn.style.background = "#e74c3c";
          btn.innerText = loc;
          btn.onclick = () => { 
              currentLocation = loc; 
              loadMenuUI();
          };
          locContainer.appendChild(btn);
      });
  }

  const categories = [...new Set(globalMenuData.filter(i => i.location === currentLocation).map(i => i.category))];
  if (!currentSubCategory || !categories.includes(currentSubCategory)) {
      currentSubCategory = categories[0] || "";
  }

  if (catContainer) {
      catContainer.innerHTML = "";
      categories.forEach(cat => {
          const btn = document.createElement("button");
          btn.className = `cat-btn ${cat === currentSubCategory ? "active" : ""}`;
          btn.innerText = cat;
          btn.onclick = () => { 
              currentSubCategory = cat; 
              Array.from(catContainer.children).forEach(b => b.classList.remove("active"));
              btn.classList.add("active");
              renderProductGrid(); 
          };
          catContainer.appendChild(btn);
      });
  }
  renderProductGrid();
}

function renderProductGrid() {
  const grid = document.getElementById("product-grid"); grid.innerHTML = "";
  globalMenuData.filter(i => i.location === currentLocation && i.category === currentSubCategory).forEach(item => {
    const isOutOfStock = item.trackStock && item.currentStock <= 0;
    const card = document.createElement("div"); 
    card.className = "product-card";
    
    if (isOutOfStock) {
        card.style.opacity = "0.5";
        card.style.cursor = "not-allowed";
        card.style.borderColor = "#f8d7da";
    }
    
    let stockColor = isOutOfStock ? "#c0392b" : "#e67e22";
    let stockHtml = item.trackStock ? `<div style="font-size:11px; font-weight:bold; color:${stockColor}; margin-top:5px;">Stok: ${item.currentStock}</div>` : "";
    card.innerHTML = `<div><h4 style="margin:0 0 5px 0;">${item.name}</h4>${stockHtml}</div> <div class="price-badge">Rp ${item.price.toLocaleString('id-ID')}</div>`;
    
    card.onclick = () => { 
        if(isMenuLocked) return; 
        if (isOutOfStock) return; 
        if (item.inputMode === "DECIMAL") openNumpad(item); 
        else addToCart(item, 1); 
    };
    grid.appendChild(card);
  });
}

function openNumpad(item) { activeNumpadItem = item; numpadValue = "0"; document.getElementById("numpad-display").innerText = "0"; document.getElementById("numpad-modal").classList.remove("hidden"); }
function closeNumpad() { document.getElementById("numpad-modal").classList.add("hidden"); activeNumpadItem = null; }
function numpadPress(val) {
  if (val === 'DEL') numpadValue = numpadValue.slice(0, -1) || "0";
  else if (val === '.') { if (!numpadValue.includes('.')) numpadValue += '.'; }
  else numpadValue = numpadValue === "0" ? String(val) : numpadValue + val;
  document.getElementById("numpad-display").innerText = numpadValue;
}
function confirmNumpad() { let qty = parseFloat(numpadValue); if (qty > 0) addToCart(activeNumpadItem, qty); closeNumpad(); }

function addToCart(item, qty) {
  let finalQty = qty; 
  const existing = currentCart.find(i => i.itemId === item.itemId);
  const currentCartQty = existing ? existing.qty : 0;
  
  if (item.trackStock && (currentCartQty + finalQty > item.currentStock)) {
      return alert(`Stok tidak cukup! Hanya tersisa ${item.currentStock} ${item.name}.`);
  }
  
  if (existing) existing.qty += finalQty; 
  else currentCart.push({ ...item, qty: finalQty, price: item.price }); 
  
  renderCart();
}

window.updateCartItemQty = function(itemId, delta) {
  let existing = currentCart.find(i => i.itemId === itemId);
  if (existing) {
    if (delta > 0 && existing.trackStock && (existing.qty + delta > existing.currentStock)) {
        return alert(`Stok maksimal tercapai! Hanya tersedia ${existing.currentStock}.`);
    }
      
    existing.qty += delta;
    if (existing.qty <= 0) currentCart = currentCart.filter(i => i.itemId !== itemId);
    renderCart();
  }
};

function renderCart() {
  const container = document.getElementById("cart-items"); container.innerHTML = ""; let total = 0;
  currentCart.forEach(item => {
    const lineTotal = item.qty * item.price; total += lineTotal;
    container.innerHTML += `
      <div class="cart-item">
        <div class="cart-item-header">
          <span>${item.name}</span>
          <span style="color:#e74c3c;">Rp ${lineTotal.toLocaleString('id-ID')}</span>
        </div>
        <div style="display:flex; justify-content:space-between; align-items:center;">
            <span style="font-size:12px; color:#7f8c8d;">Rp ${item.price.toLocaleString('id-ID')} / item</span>
            <div style="display:flex; align-items:center; background:#ecf0f1; border-radius:8px; overflow:hidden; border:1px solid #bdc3c7;">
              <button onclick="updateCartItemQty('${item.itemId}', -1)" style="border:none; background:#ecf0f1; color:#e74c3c; width:35px; height:32px; font-weight:bold; font-size:18px; cursor:pointer;">-</button>
              <span style="width:40px; text-align:center; font-weight:bold; color:#2c3e50;">${item.qty % 1 !== 0 ? item.qty.toFixed(2) : item.qty}</span>
              <button onclick="updateCartItemQty('${item.itemId}', 1)" style="border:none; background:#ecf0f1; color:#27ae60; width:35px; height:32px; font-weight:bold; font-size:18px; cursor:pointer;">+</button>
            </div>
        </div>
      </div>`;
  });
  document.getElementById("cart-total").innerText = `Rp ${total.toLocaleString('id-ID')}`; window.cartSubtotal = total; window.cartGrandTotal = total;
}

function clearCart() { lockMenu(); }

function reviewOrder() {
  if (currentCart.length === 0) return alert("Keranjang kosong!");
  
  window.laundrySubtotal = 0;
  window.hotelSubtotal = 0;
  currentCart.forEach(item => {
      if (String(item.location).toLowerCase().includes("laundry")) {
          window.laundrySubtotal += (item.price * item.qty);
      } else {
          window.hotelSubtotal += (item.price * item.qty);
      }
  });

  document.getElementById("pay-qris-laundry").value = 0; 
  document.getElementById("pay-transfer-hotel").value = 0;
  
  window.cartGrandTotal = window.cartSubtotal;
  document.getElementById("review-subtotal").innerText = `Rp ${window.cartSubtotal.toLocaleString('id-ID')}`;
  document.getElementById("review-grandtotal").innerText = `Rp ${window.cartGrandTotal.toLocaleString('id-ID')}`;
  
  autoCalcCash(); 
  document.getElementById("review-modal").classList.remove("hidden");
}

window.autoCalcCash = function() {
  let qrisL = Number(document.getElementById("pay-qris-laundry").value) || 0;
  let transH = Number(document.getElementById("pay-transfer-hotel").value) || 0;
  
  let nonCashTotal = qrisL + transH;
  let targetTotalCash = window.cartGrandTotal - nonCashTotal;
  
  document.getElementById("pay-cash-total").value = Math.max(0, targetTotalCash);
  calculateRemaining();
}

window.calculateRemaining = function() {
  let cashTotal = Number(document.getElementById("pay-cash-total").value) || 0;
  let qL = Number(document.getElementById("pay-qris-laundry").value) || 0; 
  let tH = Number(document.getElementById("pay-transfer-hotel").value) || 0; 
  
  let totalAccounted = cashTotal + qL + tH;
  let remaining = window.cartGrandTotal - totalAccounted;
  document.getElementById("review-remaining").innerText = `Rp ${remaining.toLocaleString('id-ID')}`;
}

function closeReview() {
    document.getElementById("review-modal").classList.add("hidden");
}

async function finalizeOrder(shouldPrint) {
  const cashTotal = Number(document.getElementById("pay-cash-total").value) || 0;
  const qris = Number(document.getElementById("pay-qris-laundry").value) || 0; 
  const transfer = Number(document.getElementById("pay-transfer-hotel").value) || 0;
  
  const totalAccounted = cashTotal + qris + transfer;
  if (window.cartGrandTotal - totalAccounted !== 0) return alert("Jumlah Pembayaran Mismatch! (Kurang/Lebih Bayar)");

  let needLaundryCash = Math.max(0, window.laundrySubtotal - qris);
  let finalCashLaundry = Math.min(cashTotal, needLaundryCash);
  let finalCashHotel = cashTotal - finalCashLaundry;
  
  let roomElement = document.getElementById("cust-room");
  const roomNumber = roomElement ? roomElement.value || "-" : "-";
  let custName = roomNumber === "-" ? "Tamu Walk-in / Luar" : "Tamu Kamar " + roomNumber;

  let payMethods = []; 
  if(finalCashLaundry > 0) payMethods.push("Tunai(Lndry)"); 
  if(finalCashHotel > 0) payMethods.push("Tunai(Htl)"); 
  if(qris > 0) payMethods.push("QRIS(Lndry)"); 
  if(transfer > 0) payMethods.push("Trnsfr(Htl)"); 
  
  let status = "Completed"; 
  if (currentCart.some(i => String(i.workflow).toUpperCase() === "TICKET")) status = "Processing";

  const orderPayload = {
    orderId: "ORD-" + Date.now(), timestamp: new Date().toISOString(), cashier: currentCashier, shiftId: currentShiftId,
    customerName: custName, customerPhone: "-", roomNumber: roomNumber, orderStatus: status, items: currentCart, subtotal: window.cartSubtotal, discounts: 0, grandTotal: window.cartGrandTotal,
    paymentMethod: payMethods.join("+"), 
    cashAmount: cashTotal, cashLaundry: finalCashLaundry, cashHotel: finalCashHotel,
    qrisAmount: qris, transferAmount: transfer, hotelPiutangAmount: 0, tamuPiutangAmount: 0, freeAmount: 0,
    syncStatus: "Pending"
  };

  const txMenu = db.transaction(["menu"], "readwrite").objectStore("menu");
  currentCart.forEach(cartItem => {
    txMenu.get(cartItem.itemId).onsuccess = (ev) => {
      const menuItem = ev.target.result;
      if (menuItem && menuItem.trackStock) { menuItem.currentStock = Math.max(0, menuItem.currentStock - cartItem.qty); txMenu.put(menuItem); }
    };
  });

  db.transaction(["orders"], "readwrite").objectStore("orders").add(orderPayload);
  if (status === "Processing") activeLaundryTickets.unshift(orderPayload);

  if (shouldPrint) await buildEscPosReceipt(orderPayload.orderId, orderPayload, totalAccounted, payMethods.join("+"));
  closeReview(); lockMenu(); loadMenuUI(); runBackgroundSync();
}

function renderActiveTickets() {
  const grid = document.getElementById("ticket-grid-container"); grid.innerHTML = "";
  activeLaundryTickets.forEach((ticket) => {
    const isReady = ticket.orderStatus === "Ready for Pickup";
    const totalPaid = (ticket.cashAmount||0) + (ticket.qrisAmount||0) + (ticket.transferAmount||0) + (ticket.freeAmount||0);
    const remaining = ticket.grandTotal - totalPaid;
    let text = ticket.readableReceipt || (ticket.items ? ticket.items.map(i => `${i.qty}x ${i.name}`).join('\n') : "");
    let btnHtml = !isReady ? `<button class="ticket-btn" style="background:#f39c12;" onclick="markTicketReady('${ticket.orderId}')">Tandai Selesai</button>` 
                           : `<button class="ticket-btn" style="background:#27ae60;" onclick="openSettlement('${ticket.orderId}', ${remaining})">Tutup Bill</button>`;
    
    grid.innerHTML += `
      <div class="ticket-card ${isReady ? 'ready' : ''}">
        <div class="ticket-header">
            <span>${ticket.customerName}</span>
            <span>Kmr: ${ticket.roomNumber||'-'}</span>
        </div>
        <div class="ticket-body">${text}</div>
        <div class="ticket-footer">
            <div style="font-size:12px; color:#7f8c8d; margin-bottom:5px;">Kekurangan / Sisa Bayar:</div>
            <div style="font-size:18px; font-weight:900; color:#c0392b; margin-bottom:15px;">Rp ${remaining.toLocaleString('id-ID')}</div>
            ${btnHtml}
        </div>
      </div>`;
  });
}

function markTicketReady(orderId) {
  const ticket = activeLaundryTickets.find(t => t.orderId === orderId);
  if (ticket) {
    ticket.orderStatus = "Ready for Pickup"; ticket.syncStatus = "Pending";
    db.transaction(["orders"], "readwrite").objectStore("orders").put(ticket);
    renderActiveTickets(); runBackgroundSync();
  }
}

function openSettlement(orderId, remainingDue) {
  activeSettlementTicket = activeLaundryTickets.find(t => t.orderId === orderId);
  if (!activeSettlementTicket) return;
  
  if (remainingDue <= 0) {
      activeSettlementTicket.orderStatus = "Completed"; 
      activeSettlementTicket.syncStatus = "Pending";
      db.transaction(["orders"], "readwrite").objectStore("orders").put(activeSettlementTicket);
      activeLaundryTickets = activeLaundryTickets.filter(t => t.orderId !== activeSettlementTicket.orderId);
      renderActiveTickets(); 
      runBackgroundSync();
      return; 
  }
  
  document.getElementById("settle-amount").innerText = `Rp ${remainingDue.toLocaleString('id-ID')}`;
  document.getElementById("settle-cash").value = remainingDue; 
  document.getElementById("settle-qris").value = 0; 
  document.getElementById("settle-transfer").value = 0;
  document.getElementById("settlement-modal").classList.remove("hidden");
}

function confirmSettlement() {
  if (!activeSettlementTicket) return;
  activeSettlementTicket.cashAmount += Number(document.getElementById("settle-cash").value) || 0;
  activeSettlementTicket.qrisAmount += Number(document.getElementById("settle-qris").value) || 0;
  activeSettlementTicket.transferAmount += Number(document.getElementById("settle-transfer").value) || 0;
  activeSettlementTicket.orderStatus = "Completed"; activeSettlementTicket.syncStatus = "Pending";
  db.transaction(["orders"], "readwrite").objectStore("orders").put(activeSettlementTicket);
  activeLaundryTickets = activeLaundryTickets.filter(t => t.orderId !== activeSettlementTicket.orderId);
  document.getElementById("settlement-modal").classList.add("hidden"); renderActiveTickets(); runBackgroundSync();
}

function openExpenseModal() {
  document.getElementById("expense-modal").classList.remove("hidden");
  const list = document.getElementById("expense-category-list"); list.innerHTML = "";
  db.transaction(["expense_categories"], "readonly").objectStore("expense_categories").getAll().onsuccess = (e) => { e.target.result.forEach(cat => { const opt = document.createElement("option"); opt.value = cat.name; list.appendChild(opt); }); };
}

function saveExpense() {
  const amount = Number(document.getElementById("exp-amount").value); const category = document.getElementById("exp-category").value.trim();
  if (amount <= 0 || !category) return alert("Input tidak valid.");
  db.transaction(["expense_categories"], "readwrite").objectStore("expense_categories").put({ name: category });
  const payload = { expenseId: "EXP-" + Date.now(), timestamp: new Date().toISOString(), cashier: currentCashier, shiftId: currentShiftId, category: category, description: document.getElementById("exp-desc").value || "-", amount: amount, status: "Active", syncStatus: "Pending" };
  db.transaction(["expenses"], "readwrite").objectStore("expenses").add(payload);
  document.getElementById("expense-modal").classList.add("hidden"); alert("Pengeluaran Dicatat!"); runBackgroundSync();
}

function openHistoryModal() { 
  document.getElementById("history-modal").classList.remove("hidden"); 
  renderHistoryList('orders'); 
}

function renderHistoryList(type) {
  const container = document.getElementById("history-container"); container.innerHTML = "";
  if (type === 'orders') {
    db.transaction(["orders"], "readonly").objectStore("orders").getAll().onsuccess = (e) => {
      let items = e.target.result.reverse(); 
      if(items.length === 0) container.innerHTML = `<div style="padding:20px;text-align:center;color:#7f8c8d;">Belum ada nota di sistem ini.</div>`;
      items.forEach(o => {
        container.innerHTML += `<div class="history-row"><div><strong>${o.customerName} (Kmr: ${o.roomNumber||'-'})</strong><br><small>${formatTimeOnlyWIB(o.timestamp)} | Rp ${o.grandTotal.toLocaleString('id-ID')}</small></div><div><span class="status-badge status-paid">${o.orderStatus}</span></div></div>`;
      });
    };
  } else if (type === 'expenses') {
    db.transaction(["expenses"], "readonly").objectStore("expenses").getAll().onsuccess = (e) => {
      let items = e.target.result.reverse();
      if(items.length === 0) container.innerHTML = `<div style="padding:20px;text-align:center;color:#7f8c8d;">Belum ada pengeluaran.</div>`;
      items.forEach(exp => {
        container.innerHTML += `<div class="history-row"><div><strong>${exp.category}</strong><br><small>${formatTimeOnlyWIB(exp.timestamp)} | Rp ${exp.amount.toLocaleString('id-ID')}</small></div></div>`;
      });
    };
  } else if (type === 'shifts') {
    db.transaction(["shift_reports"], "readonly").objectStore("shift_reports").getAll().onsuccess = (e) => {
      let shifts = e.target.result.sort((a,b) => new Date(b.loginTime) - new Date(a.loginTime));
      if(shifts.length === 0) container.innerHTML = `<div style="padding:20px;text-align:center;color:#7f8c8d;">Belum ada riwayat shift di sistem.</div>`;
      shifts.forEach(sh => {
        container.innerHTML += `<div class="history-row"><div><strong>${sh.shiftId} (${sh.cashier})</strong><br><small>${formatWIB(sh.loginTime)}</small></div><div style="text-align:right;"><strong style="color:#2c3e50;">Omset: Rp ${sh.totalOmset.toLocaleString('id-ID')}</strong><br><small style="color:#27ae60;">Kas Netto: Rp ${sh.netCash.toLocaleString('id-ID')}</small></div></div>`;
      });
    };
  } else if (type === 'drops') {
    db.transaction(["cash_drops"], "readonly").objectStore("cash_drops").getAll().onsuccess = (e) => {
      let drops = e.target.result.sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp));
      if(drops.length === 0) container.innerHTML = `<div style="padding:20px;text-align:center;color:#7f8c8d;">Belum ada riwayat penarikan laci.</div>`;
      drops.forEach(d => {
        let amt = (d.toAdmin || 0) + (d.toBank || 0);
        container.innerHTML += `<div class="history-row"><div><strong>Laci Diambil: Rp ${amt.toLocaleString('id-ID')}</strong><br><small>${formatWIB(d.timestamp)} | Oleh: ${d.cashier}</small></div><div style="text-align:right; font-size:12px; color:#7f8c8d; max-width:120px;">${d.notes || "Setor BO/Bank"}</div></div>`;
      });
    };
  }
}

function openShiftReport() {
  let tOrders = 0, tCustomers = 0, tOmset = 0, tCashTotal = 0, tCashL = 0, tCashH = 0, tQris = 0, tTransfer = 0, tExpense = 0;
  let itemsSoldGroups = {};

  db.transaction(["orders"], "readonly").objectStore("orders").getAll().onsuccess = (e) => {
    e.target.result.filter(o => o.shiftId === currentShiftId).forEach(o => {
      tOrders++; tCustomers++;
      tOmset += o.grandTotal; 
      tCashTotal += (o.cashAmount || 0); 
      tCashL += (o.cashLaundry || 0);
      tCashH += (o.cashHotel || 0);
      tQris += (o.qrisAmount || 0); 
      tTransfer += (o.transferAmount || 0);
      
      if (o.items) {
          o.items.forEach(i => { 
             let loc = i.location || "Other";
             let cat = i.category || "Uncategorized";
             if (!itemsSoldGroups[loc]) itemsSoldGroups[loc] = {};
             if (!itemsSoldGroups[loc][cat]) itemsSoldGroups[loc][cat] = {};
             itemsSoldGroups[loc][cat][i.name] = (itemsSoldGroups[loc][cat][i.name] || 0) + i.qty;
          });
      }
    });
    
    db.transaction(["expenses"], "readonly").objectStore("expenses").getAll().onsuccess = (ex) => {
      ex.target.result.filter(exp => exp.shiftId === currentShiftId && exp.status === "Active").forEach(exp => { tExpense += exp.amount; });
      let net = tCashTotal - tExpense;
      
      window.currentShiftData = { totalCustomers: tCustomers, totalOrders: tOrders, totalOmset: tOmset, totalCash: tCashTotal, totalCashLaundry: tCashL, totalCashHotel: tCashH, totalQris: tQris, totalTransfer: tTransfer, totalHotelPiutang: 0, totalTamuPiutang: 0, totalFree: 0, totalExpenses: tExpense, net: net, structuredFoodSummary: itemsSoldGroups };
      
      document.getElementById("sr-orders").innerText = tOrders; document.getElementById("sr-customers").innerText = tCustomers;
      document.getElementById("sr-omset").innerText = `Rp ${tOmset.toLocaleString('id-ID')}`; 
      
      document.getElementById("sr-cash-laundry").innerText = `Rp ${tCashL.toLocaleString('id-ID')}`;
      document.getElementById("sr-cash-hotel").innerText = `Rp ${tCashH.toLocaleString('id-ID')}`;
      document.getElementById("sr-qris").innerText = `Rp ${tQris.toLocaleString('id-ID')}`; 
      document.getElementById("sr-transfer").innerText = `Rp ${tTransfer.toLocaleString('id-ID')}`;
      document.getElementById("sr-expense").innerText = `Rp ${tExpense.toLocaleString('id-ID')}`; 
      document.getElementById("sr-net").innerText = `Rp ${net.toLocaleString('id-ID')}`;
      
      let itemsHtml = "";
      for (const loc in itemsSoldGroups) {
          itemsHtml += `<div style="break-inside: avoid; margin-bottom: 8px; background: #f8f9fa; padding: 8px; border-radius: 6px; border: 1px solid #e0e0e0;">`;
          itemsHtml += `<div style="font-weight:900; color:#e74c3c; margin-bottom:3px; border-bottom:1px solid #fcebeb; padding-bottom:2px; text-transform: uppercase; font-size: 10px; letter-spacing: 0.5px;">📍 ${loc}</div>`;
          for (const cat in itemsSoldGroups[loc]) {
              itemsHtml += `<div style="font-weight:800; color:#3498db; margin-top:4px; margin-bottom:2px; font-size: 9px; padding-left: 2px;">📂 ${cat}</div>`;
              for (const itemName in itemsSoldGroups[loc][cat]) {
                  let qty = itemsSoldGroups[loc][cat][itemName];
                  let qtyDisplay = qty % 1 !== 0 ? Number(qty).toFixed(2) : qty;
                  itemsHtml += `<div style="font-size:10px; color:#34495e; display:flex; justify-content:space-between; margin-bottom: 1px; padding-left: 8px; border-left: 2px solid #ecf0f1; line-height: 1.1;"><span>${itemName}</span> <strong style="color:#2c3e50; font-weight:800;">${qtyDisplay}x</strong></div>`;
              }
          }
          itemsHtml += `</div>`;
      }
      
      let container = document.getElementById("sr-items-summary");
      if (container) {
          container.style = "column-count: 2; column-gap: 8px; font-size:11px;";
          container.innerHTML = itemsHtml || `<div style="text-align:center; color:#7f8c8d; font-size: 11px; padding: 20px 0;">Belum ada item terjual</div>`;
      }
      
      document.getElementById("shift-report-modal").classList.remove("hidden");
    };
  };
}

async function printCurrentShiftReport() { await buildShiftReportReceipt({ ...window.currentShiftData, shiftId: currentShiftId, cashier: currentCashier, loginTime: currentLoginTime, logoutTime: new Date().toISOString() }); }

function initiateLogoutSequence() {
  let tx = db.transaction(["active_shifts"], "readwrite");
  tx.objectStore("active_shifts").delete(currentPin);
  tx.oncomplete = () => { window.location.reload(); };
}

function lockScreen() { window.location.reload(); }

async function runBackgroundSync() {
  if (!navigator.onLine || isSyncing) return; isSyncing = true;
  try {
    let orders = await new Promise(res => db.transaction(["orders"], "readonly").objectStore("orders").getAll().onsuccess = e => res(e.target.result));
    for (const order of orders) {
      if (order.syncStatus === "Pending") {
        try {
          let r = await fetch(API_URL, { method: 'POST', body: JSON.stringify({ action: "syncOrder", data: order }) });
          if ((await r.json()).status === "Success") { order.syncStatus = "Synced"; db.transaction(["orders"], "readwrite").objectStore("orders").put(order); }
        } catch(e) {}
      }
    }
    let expenses = await new Promise(res => db.transaction(["expenses"], "readonly").objectStore("expenses").getAll().onsuccess = e => res(e.target.result));
    for (const exp of expenses) {
      if (exp.syncStatus === "Pending") {
        try {
          let r = await fetch(API_URL, { method: 'POST', body: JSON.stringify({ action: "syncExpense", data: exp }) });
          if ((await r.json()).status === "Success") { exp.syncStatus = "Synced"; db.transaction(["expenses"], "readwrite").objectStore("expenses").put(exp); }
        } catch(e) {}
      }
    }
    let drops = await new Promise(res => db.transaction(["cash_drops"], "readonly").objectStore("cash_drops").getAll().onsuccess = e => res(e.target.result));
    for (const drop of drops) {
      if (drop.syncStatus === "Pending") {
        try {
          let r = await fetch(API_URL, { method: 'POST', body: JSON.stringify({ action: "syncCashDrop", data: drop }) });
          if ((await r.json()).status === "Success") { drop.syncStatus = "Synced"; db.transaction(["cash_drops"], "readwrite").objectStore("cash_drops").put(drop); }
        } catch(e) {}
      }
    }
  } finally { isSyncing = false; }
}

window.openCashDrop = async function(isBank) {
    document.getElementById("cash-drop-modal").classList.remove("hidden");
    document.getElementById("drop-amount").value = "";
    document.getElementById("drop-notes").value = "";
    
    let tCash = 0, tExpense = 0;
    const orders = await new Promise(res => db.transaction(["orders"], "readonly").objectStore("orders").getAll().onsuccess = e => res(e.target.result));
    orders.filter(o => o.shiftId === currentShiftId).forEach(o => { tCash += o.cashAmount; });
    
    const exps = await new Promise(res => db.transaction(["expenses"], "readonly").objectStore("expenses").getAll().onsuccess = e => res(e.target.result));
    exps.filter(exp => exp.shiftId === currentShiftId && exp.status === "Active").forEach(exp => { tExpense += exp.amount; });
    
    let tDrop = 0;
    const drops = await new Promise(res => db.transaction(["cash_drops"], "readonly").objectStore("cash_drops").getAll().onsuccess = e => res(e.target.result));
    drops.filter(d => d.shiftId === currentShiftId).forEach(d => { tDrop += (d.toAdmin + d.toBank); });

    let netDrawer = tCash - tExpense - tDrop + window.masterDrawerBalance;
    document.getElementById("live-drawer-display").innerText = `Rp ${netDrawer.toLocaleString('id-ID')}`;
    window.currentDrawerBalanceEstimate = netDrawer;
};

window.submitCashDrop = function() {
    const amount = Number(document.getElementById("drop-amount").value);
    if (amount <= 0) return alert("Nominal tidak valid");
    const dest = document.getElementById("drop-destination").value;
    const notes = document.getElementById("drop-notes").value || "-";
    
    const dropPayload = {
        dropId: "DRP-" + Date.now(), timestamp: new Date().toISOString(), cashier: currentCashier, shiftId: currentShiftId,
        toAdmin: dest === "Admin" ? amount : 0, toBank: dest === "Bank" ? amount : 0, 
        leftInDrawer: window.currentDrawerBalanceEstimate - amount, notes: notes, syncStatus: "Pending"
    };
    
    db.transaction(["cash_drops"], "readwrite").objectStore("cash_drops").add(dropPayload);
    document.getElementById("cash-drop-modal").classList.add("hidden");
    alert("Setoran Kas Laci Tercatat!");
    runBackgroundSync();
};

window.onload = async () => {
  await initDB(); await syncMasterData();
  window.setInterval(runBackgroundSync, 5000); window.setInterval(syncMasterData, 30000);
};
