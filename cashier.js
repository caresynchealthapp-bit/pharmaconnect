/* ============================================================================
   PHARMACONNECT - POS CASHIER TERMINAL, REALTIME STOCK & RECEIPT ENGINE
   ============================================================================ */

// 1. STRICT SECURITY GATE (Blocks direct URL typing immediately)
const activeSession = JSON.parse(sessionStorage.getItem('pc_active_session') || 'null');
const urlParams = new URLSearchParams(window.location.search);
const pId = urlParams.get('pharmacy_id');

if (
    !activeSession ||
    !pId ||
    String(activeSession.pharmacy_id) !== String(pId) ||
    !['cashier', 'admin'].includes(activeSession.role)
) {
    window.location.href = 'index.html';
    throw new Error('Security Exception: Unauthorized direct URL access blocked.');
}

// 2. SUPABASE CONFIGURATION
const SUPABASE_URL = 'https://juobkaftyrzlxbviudpy.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_qdME8AYk9rz5B4FHs4Eb1g_0vvhN73v';

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const PHARMACY_THEMES = [
    { primary: '#0d9488', secondary: '#0284c7', soft: '#ccfbf1', sidebar: '#0f172a' },
    { primary: '#4f46e5', secondary: '#7c3aed', soft: '#e0e7ff', sidebar: '#1e1b4b' },
    { primary: '#e11d48', secondary: '#ea580c', soft: '#ffe4e6', sidebar: '#270915' },
    { primary: '#d97706', secondary: '#059669', soft: '#fef3c7', sidebar: '#1c1917' }
];

// State
let currentPharmacy = null;
let availableBatches = [];
let todaySalesList = [];
let cart = [];
let selectedCategory = 'ALL';
let selectedPaymentMethod = 'Cash';
let currentInvoiceNumber = '';
let lastCompletedReceiptData = null;

// ==================== INITIALIZATION ====================
document.addEventListener('DOMContentLoaded', async () => {
    setupSessionHeader();
    startLiveClock();
    generateNewInvoiceNumber();
    setupPosShortcutsAndEvents();

    await loadPharmacyBranding(pId);
    await refreshCashierData();
});

function setupSessionHeader() {
    const staffName = activeSession.staff_name || 'Cashier';
    const counterName = activeSession.counter_name || 'Counter 01';

    document.getElementById('session-cashier-name').textContent = staffName;
    document.getElementById('session-counter-name').textContent = counterName;
    document.getElementById('active-counter-pill').textContent = `${counterName} • ${ activeSession.username || staffName }`;
}

function startLiveClock() {
    const updateClock = () => {
        const now = new Date();
        document.getElementById('live-datetime-display').textContent =
            now.toLocaleDateString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' }) +
            ' • ' +
            now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    };
    updateClock();
    setInterval(updateClock, 1000);
}

function generateNewInvoiceNumber() {
    const rand = Math.floor(10000 + Math.random() * 90000);
    currentInvoiceNumber = `INV-${rand}`;
    document.getElementById('current-invoice-no').textContent = currentInvoiceNumber;
}

function setupPosShortcutsAndEvents() {
    // Live Search Input
    document.getElementById('pos-medicine-search').addEventListener('input', () => {
        renderPosMedicineGrid();
    });

    // Barcode / Batch Input Enter Key Listener
    document.getElementById('pos-barcode-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            triggerBarcodeLookup();
        }
    });

    // Keyboard Shortcuts: F2 for Search, F4 for Barcode Gun
    document.addEventListener('keydown', (e) => {
        if (e.key === 'F2') {
            e.preventDefault();
            document.getElementById('pos-medicine-search').focus();
        } else if (e.key === 'F4') {
            e.preventDefault();
            document.getElementById('pos-barcode-input').focus();
        }
    });
}

// ==================== LOAD PHARMACY BRANDING & THEME ====================
async function loadPharmacyBranding(pharmacyId) {
    const { data, error } = await supabaseClient
        .from('pharmacies')
        .select('*')
        .eq('id', pharmacyId)
        .single();

    if (error || !data) {
        window.location.href = 'index.html';
        return;
    }

    currentPharmacy = data;
    document.title = `${data.pharmacy_name} | POS Cashier`;
    document.getElementById('sidebar-pharmacy-name').textContent = data.pharmacy_name;
    document.getElementById('sidebar-pharmacy-license').textContent = `REG: ${data.license_no}`;
    document.getElementById('sidebar-pharmacy-city').textContent = `${data.address}, ${data.city}`;
    document.getElementById('sidebar-banner').style.backgroundImage = `url('${data.image_url || ''}')`;

    const savedThemeIdx = localStorage.getItem(`theme_${data.id}`);
    const hashIdx = data.pharmacy_name.length % PHARMACY_THEMES.length;
    const theme = PHARMACY_THEMES[savedThemeIdx !== null ? Number(savedThemeIdx) : hashIdx] || PHARMACY_THEMES[0];

    const root = document.documentElement;
    root.style.setProperty('--brand-primary', theme.primary);
    root.style.setProperty('--brand-secondary', theme.secondary);
    root.style.setProperty('--brand-soft', theme.soft);
    root.style.setProperty('--sidebar-bg', theme.sidebar);
}

// ==================== FETCH LIVE STOCK & TODAY'S BUSINESS LOG ====================
async function refreshCashierData() {
    if (!currentPharmacy) return;

    const todayStr = new Date().toISOString().split('T')[0];

    const [stockRes, salesRes] = await Promise.all([
        supabaseClient
            .from('grn_stock')
            .select('*')
            .eq('pharmacy_id', currentPharmacy.id)
            .gt('current_quantity', 0)
            .gt('expiry_date', todayStr) // Automatically exclude expired stock from POS!
            .order('expiry_date', { ascending: true }), // FEFO: First Expiry First Out
        supabaseClient
            .from('sales_transactions')
            .select('*')
            .eq('pharmacy_id', currentPharmacy.id)
            .order('sold_at', { ascending: false })
    ]);

    availableBatches = stockRes.data || [];

    // Filter sales made Today (local date match)
    const allSales = salesRes.data || [];
    todaySalesList = allSales.filter((s) => {
        if (!s.sold_at) return false;
        const saleDate = new Date(s.sold_at);
        const now = new Date();
        return (
            saleDate.getFullYear() === now.getFullYear() &&
            saleDate.getMonth() === now.getMonth() &&
            saleDate.getDate() === now.getDate()
        );
    });

    renderPosMedicineGrid();
    renderCart();
    renderTodayBusinessLog();
    renderShelfLookupTable();
}

// ==================== RENDER POS MEDICINE BATCH CARDS ====================
function filterByCategory(category, btnEl) {
    selectedCategory = category;
    document.querySelectorAll('#pos-category-pills .cat-pill').forEach((b) => b.classList.remove('active'));
    btnEl.classList.add('active');
    renderPosMedicineGrid();
}

function renderPosMedicineGrid() {
    const grid = document.getElementById('pos-medicine-grid');
    const query = (document.getElementById('pos-medicine-search').value || '').toLowerCase().trim();
    grid.innerHTML = '';

    const filtered = availableBatches.filter((b) => {
        const matchesCat = selectedCategory === 'ALL' || (b.category || '').toLowerCase() === selectedCategory.toLowerCase();
        const matchesQuery =
            (b.medicine_name || '').toLowerCase().includes(query) ||
            (b.batch_number || '').toLowerCase().includes(query) ||
            (b.rack_location || '').toLowerCase().includes(query) ||
            (b.barcode || '').toLowerCase().includes(query);
        return matchesCat && matchesQuery;
    });

    if (filtered.length === 0) {
        grid.innerHTML = `
            <div style="grid-column: 1 / -1; text-align:center; padding:48px 20px; background:#fff; border-radius:14px; border:1px dashed #cbd5e1; color:#64748b;">
                <i class="fa-solid fa-box-open" style="font-size:2.2rem; margin-bottom:10px; color:#94a3b8;"></i>
                <h4>No Sellable Medicine Batches Found</h4>
                <p style="font-size:0.85rem;">Add non-expired stock in the GRN Portal or try another search term.</p>
            </div>
        `;
        return;
    }

    filtered.forEach((b) => {
        const card = document.createElement('div');
        card.className = 'pos-med-card';
        card.onclick = () => addBatchToCart(b.id, 1);

        const rackDisplay = b.rack_location || 'Main Shelf';
        const batchDisplay = b.batch_number || 'N/A';
        const isLow = b.current_quantity <= 20;

        card.innerHTML = `
            <div>
                <div class="med-card-top">
                    <span class="med-rack-tag"><i class="fa-solid fa-location-dot"></i> ${escapeHtml(rackDisplay)}</span>
                    <span class="med-stock-tag ${isLow ? 'low' : ''}">${b.current_quantity} in stock</span>
                </div>
                <h4>${escapeHtml(b.medicine_name)}</h4>
                <div class="med-batch-meta">
                    <span>Batch: <strong>${escapeHtml(batchDisplay)}</strong> • ${escapeHtml(b.category || 'Tablet')}</span>
                    <span>Exp: ${escapeHtml(b.expiry_date)}</span>
                </div>
            </div>
            <div class="med-card-footer">
                <span class="med-price">LKR ${formatCurrency(b.selling_price)}</span>
                <button type="button" class="btn-add-mini" title="Add to Bill">
                    <i class="fa-solid fa-plus"></i>
                </button>
            </div>
        `;
        grid.appendChild(card);
    });
}

// ==================== BARCODE / BATCH SCANNER HANDLER ====================
function triggerBarcodeLookup() {
    const input = document.getElementById('pos-barcode-input');
    const code = input.value.trim().toLowerCase();
    if (!code) return;

    // Match against barcode, batch_number, grn_number, or exact/partial medicine name
    const matchedBatch = availableBatches.find(
        (b) =>
            (b.barcode && b.barcode.toLowerCase() === code) ||
            (b.batch_number && b.batch_number.toLowerCase() === code) ||
            (b.grn_number && b.grn_number.toLowerCase() === code) ||
            (b.medicine_name && b.medicine_name.toLowerCase() === code)
    );

    if (!matchedBatch) {
        showToast(`No active stock batch found matching barcode/batch "${input.value}"`, 'error');
        return;
    }

    addBatchToCart(matchedBatch.id, 1);
    input.value = '';
    input.focus();
}

// ==================== CART & BILLING LOGIC ====================
function addBatchToCart(batchId, qtyToAdd = 1) {
    const batch = availableBatches.find((b) => String(b.id) === String(batchId));
    if (!batch) return;

    const existingItem = cart.find((item) => String(item.batch.id) === String(batchId));

    if (existingItem) {
        if (existingItem.qty + qtyToAdd > batch.current_quantity) {
            showToast(`Cannot exceed available stock (${batch.current_quantity} units) for ${batch.medicine_name}!`, 'error');
            return;
        }
        existingItem.qty += qtyToAdd;
    } else {
        cart.push({
            batch: batch,
            qty: qtyToAdd
        });
    }

    renderCart();
}

function updateCartItemQty(batchId, newQty) {
    const item = cart.find((i) => String(i.batch.id) === String(batchId));
    if (!item) return;

    const parsed = parseInt(newQty, 10);
    if (isNaN(parsed) || parsed <= 0) {
        removeCartItem(batchId);
        return;
    }

    if (parsed > item.batch.current_quantity) {
        showToast(`Only ${item.batch.current_quantity} units available in this batch!`, 'error');
        item.qty = item.batch.current_quantity;
    } else {
        item.qty = parsed;
    }

    renderCart();
}

function removeCartItem(batchId) {
    cart = cart.filter((i) => String(i.batch.id) !== String(batchId));
    renderCart();
}

function clearCart() {
    cart = [];
    document.getElementById('cust-name').value = '';
    document.getElementById('cust-phone').value = '';
    document.getElementById('cart-discount-pct').value = '0';
    document.getElementById('cash-received-input').value = '';
    generateNewInvoiceNumber();
    renderCart();
}

function renderCart() {
    const container = document.getElementById('pos-cart-items');
    container.innerHTML = '';

    if (cart.length === 0) {
        container.innerHTML = `
            <div style="text-align:center; padding:40px 12px; color:#94a3b8;">
                <i class="fa-solid fa-basket-shopping" style="font-size:2rem; margin-bottom:8px;"></i>
                <p style="font-size:0.85rem; font-weight:600;">Bill is empty. Click a medicine card or scan a barcode to begin.</p>
            </div>
        `;
        recalculateCartTotals();
        return;
    }

    cart.forEach((item) => {
        const lineTotal = item.qty * Number(item.batch.selling_price);
        const row = document.createElement('div');
        row.className = 'cart-item-row';
        row.innerHTML = `
            <div class="cart-item-top">
                <div>
                    <div>${escapeHtml(item.batch.medicine_name)}</div>
                    <small style="color:#64748b; font-weight:600;">
                        Batch: ${escapeHtml(item.batch.batch_number || 'N/A')} • LKR ${formatCurrency(item.batch.selling_price)}/unit
                    </small>
                </div>
                <button type="button" class="cart-item-remove" onclick="removeCartItem('${item.batch.id}')">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>
            <div class="cart-item-bottom">
                <div class="qty-stepper">
                    <button type="button" class="qty-btn" onclick="updateCartItemQty('${item.batch.id}', ${item.qty - 1})">-</button>
                    <input type="number" class="qty-input" value="${item.qty}" min="1" max="${item.batch.current_quantity}" onchange="updateCartItemQty('${item.batch.id}', this.value)">
                    <button type="button" class="qty-btn" onclick="updateCartItemQty('${item.batch.id}', ${item.qty + 1})">+</button>
                </div>
                <strong style="color:var(--text-main);">LKR ${formatCurrency(lineTotal)}</strong>
            </div>
        `;
        container.appendChild(row);
    });

    recalculateCartTotals();
}

function recalculateCartTotals() {
    const totalUnits = cart.reduce((sum, i) => sum + i.qty, 0);
    const subtotal = cart.reduce((sum, i) => sum + i.qty * Number(i.batch.selling_price), 0);

    const discPct = Math.min(100, Math.max(0, parseFloat(document.getElementById('cart-discount-pct').value) || 0));
    const discountAmt = subtotal * (discPct / 100);
    const grandTotal = Math.max(0, subtotal - discountAmt);

    document.getElementById('cart-total-items').textContent = totalUnits;
    document.getElementById('cart-subtotal').textContent = `LKR ${formatCurrency(subtotal)}`;
    document.getElementById('cart-discount-amt').textContent = `- LKR ${formatCurrency(discountAmt)}`;
    document.getElementById('cart-grand-total').textContent = `LKR ${formatCurrency(grandTotal)}`;

    calculateChangeBalance();
    return { totalUnits, subtotal, discPct, discountAmt, grandTotal };
}

function selectPaymentMethod(method, btnEl) {
    selectedPaymentMethod = method;
    document.querySelectorAll('.pay-method-btn').forEach((b) => b.classList.remove('active'));
    btnEl.classList.add('active');

    const tenderBox = document.getElementById('cash-tender-box');
    tenderBox.style.display = method === 'Cash' ? 'block' : 'none';
}

function setQuickCash(amount) {
    const { grandTotal } = recalculateCartTotals();
    const input = document.getElementById('cash-received-input');
    if (amount === 'EXACT') {
        input.value = grandTotal.toFixed(2);
    } else {
        input.value = ((parseFloat(input.value) || 0) + Number(amount)).toFixed(2);
    }
    calculateChangeBalance();
}

function calculateChangeBalance() {
    const subtotal = cart.reduce((sum, i) => sum + i.qty * Number(i.batch.selling_price), 0);
    const discPct = Math.min(100, Math.max(0, parseFloat(document.getElementById('cart-discount-pct').value) || 0));
    const grandTotal = Math.max(0, subtotal - subtotal * (discPct / 100));

    const cashReceived = parseFloat(document.getElementById('cash-received-input').value) || 0;
    const change = cashReceived - grandTotal;

    const display = document.getElementById('cash-change-display');
    if (cashReceived === 0) {
        display.textContent = 'LKR 0.00';
        display.style.color = '#15803d';
    } else if (change < 0) {
        display.textContent = `Short: LKR ${formatCurrency(Math.abs(change))}`;
        display.style.color = '#dc2626';
    } else {
        display.textContent = `LKR ${formatCurrency(change)}`;
        display.style.color = '#15803d';
    }
}

// ==================== FINALIZE SALE (REALTIME DB UPDATE + PRINT RECEIPT) ====================
async function finalizeSaleAndPrint() {
    if (cart.length === 0) {
        showToast('Please add at least one medicine to the bill before checkout!', 'error');
        return;
    }

    const { totalUnits, subtotal, discPct, discountAmt, grandTotal } = recalculateCartTotals();
    const cashReceived = parseFloat(document.getElementById('cash-received-input').value) || grandTotal;

    if (selectedPaymentMethod === 'Cash' && cashReceived < grandTotal) {
        showToast('Cash received is less than the Net Payable amount!', 'error');
        return;
    }

    const checkoutBtn = document.getElementById('btn-complete-sale');
    checkoutBtn.disabled = true;
    checkoutBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Updating Inventory & Recording Sale...';

    const saleTimestamp = new Date().toISOString();
    const counterName = activeSession.counter_name || 'Counter 01';
    const cashierUsername = activeSession.username || activeSession.staff_name || 'cashier';
    const customerName = document.getElementById('cust-name').value.trim() || 'Walk-in Customer';
    const customerPhone = document.getElementById('cust-phone').value.trim() || '-';

    const discountMultiplier = 1 - discPct / 100;

    try {
        // 1. Deduct stock from `public.grn_stock` for each batch in the cart
        for (const item of cart) {
            const newQty = Math.max(0, Number(item.batch.current_quantity) - item.qty);
            const { error: stockErr } = await supabaseClient
                .from('grn_stock')
                .update({ current_quantity: newQty })
                .eq('id', item.batch.id)
                .eq('pharmacy_id', currentPharmacy.id);

            if (stockErr) throw stockErr;
        }

        // 2. Insert sales rows into `public.sales_transactions` (Feeds Admin Graphs & Counter Filter)
        const salesRowsToInsert = cart.map((item) => {
            const rawLineTotal = item.qty * Number(item.batch.selling_price);
            const netLineTotal = rawLineTotal * discountMultiplier;
            const totalLineCost = item.qty * Number(item.batch.unit_cost);
            const netLineProfit = netLineTotal - totalLineCost;

            return {
                pharmacy_id: currentPharmacy.id,
                invoice_no: currentInvoiceNumber,
                counter_name: counterName,
                cashier_username: cashierUsername,
                medicine_name: item.batch.medicine_name,
                quantity_sold: item.qty,
                unit_cost: Number(item.batch.unit_cost),
                unit_price: Number(item.batch.selling_price),
                total_amount: Number(netLineTotal.toFixed(2)),
                profit_amount: Number(netLineProfit.toFixed(2)),
                sold_at: saleTimestamp
            };
        });

        const { error: saleErr } = await supabaseClient
            .from('sales_transactions')
            .insert(salesRowsToInsert);

        if (saleErr) throw saleErr;

        // 3. Prepare Receipt Data & Open Full-Option Print Modal
        lastCompletedReceiptData = {
            invoice_no: currentInvoiceNumber,
            sold_at: saleTimestamp,
            counter_name: counterName,
            cashier_username: cashierUsername,
            customer_name: customerName,
            customer_phone: customerPhone,
            payment_method: selectedPaymentMethod,
            subtotal: subtotal,
            discount_pct: discPct,
            discount_amt: discountAmt,
            grand_total: grandTotal,
            cash_received: selectedPaymentMethod === 'Cash' ? cashReceived : grandTotal,
            change_due: selectedPaymentMethod === 'Cash' ? Math.max(0, cashReceived - grandTotal) : 0,
            items: cart.map((i) => ({
                medicine_name: i.batch.medicine_name,
                batch_number: i.batch.batch_number || 'N/A',
                expiry_date: i.batch.expiry_date,
                qty: i.qty,
                unit_price: Number(i.batch.selling_price),
                line_total: i.qty * Number(i.batch.selling_price)
            }))
        };

        showToast(`Sale ${currentInvoiceNumber} completed! Stock & Admin graphs updated.`);
        openReceiptModal(lastCompletedReceiptData);

        // Clear cart & reload fresh stock and Today's Business Log
        clearCart();
        await refreshCashierData();

    } catch (err) {
        console.error('Checkout error:', err);
        showToast(err.message || 'Checkout failed.', 'error');
    } finally {
        checkoutBtn.disabled = false;
        checkoutBtn.innerHTML = '<i class="fa-solid fa-print"></i> Complete Order & Print Bill';
    }
}

// ==================== TODAY'S BUSINESS LOG TAB ====================
function renderTodayBusinessLog() {
    const filterMode = document.getElementById('daylog-counter-filter').value;
    const myCounter = activeSession.counter_name || 'Counter 01';

    const filteredRows = filterMode === 'MY_COUNTER'
        ? todaySalesList.filter((s) => s.counter_name === myCounter)
        : todaySalesList;

    // Group individual medicine rows by `invoice_no` so bills appear cleanly
    const invoiceGroups = {};
    filteredRows.forEach((row) => {
        const inv = row.invoice_no || 'INV-UNKNOWN';
        if (!invoiceGroups[inv]) {
            invoiceGroups[inv] = {
                invoice_no: inv,
                sold_at: row.sold_at,
                counter_name: row.counter_name,
                cashier_username: row.cashier_username,
                total_units: 0,
                total_bill: 0,
                total_profit: 0,
                items: []
            };
        }
        invoiceGroups[inv].total_units += Number(row.quantity_sold || 0);
        invoiceGroups[inv].total_bill += Number(row.total_amount || 0);
        invoiceGroups[inv].total_profit += Number(row.profit_amount || 0);
        invoiceGroups[inv].items.push({
            medicine_name: row.medicine_name,
            batch_number: 'Recorded',
            expiry_date: '-',
            qty: Number(row.quantity_sold),
            unit_price: Number(row.unit_price),
            line_total: Number(row.quantity_sold) * Number(row.unit_price)
        });
    });

    const invoicesArray = Object.values(invoiceGroups);

    // Update Topbar & Today's Log KPIs
    const totalRev = filteredRows.reduce((s, r) => s + Number(r.total_amount || 0), 0);
    const totalUnits = filteredRows.reduce((s, r) => s + Number(r.quantity_sold || 0), 0);
    const totalProfit = filteredRows.reduce((s, r) => s + Number(r.profit_amount || 0), 0);

    document.getElementById('topbar-today-total').textContent = `LKR ${formatCurrency(totalRev)}`;
    document.getElementById('sidebar-today-count').textContent = invoicesArray.length;

    document.getElementById('log-kpi-revenue').textContent = `LKR ${formatCurrency(totalRev)}`;
    document.getElementById('log-kpi-invoices').textContent = `${invoicesArray.length} Bills`;
    document.getElementById('log-kpi-units').textContent = `${totalUnits} Units`;
    document.getElementById('log-kpi-profit').textContent = `LKR ${formatCurrency(totalProfit)}`;

    const tbody = document.getElementById('today-log-tbody');
    tbody.innerHTML = '';

    if (invoicesArray.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:#64748b;">No sales recorded for today yet. Complete an order in the POS Terminal to see it logged here.</td></tr>`;
        return;
    }

    invoicesArray.forEach((inv) => {
        const timeStr = new Date(inv.sold_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        const itemSummary = inv.items.map((i) => `${escapeHtml(i.medicine_name)} (x${i.qty})`).join(', ');

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><strong>${timeStr}</strong></td>
            <td><code>${escapeHtml(inv.invoice_no)}</code></td>
            <td>
                <span class="badge badge-info">${escapeHtml(inv.counter_name)}</span>
                <small style="display:block; color:#64748b; margin-top:2px;">${escapeHtml(inv.cashier_username)}</small>
            </td>
            <td style="max-width:300px;">${itemSummary}</td>
            <td><strong>${inv.total_units}</strong> Units</td>
            <td><strong style="color:var(--brand-primary);">LKR ${formatCurrency(inv.total_bill)}</strong></td>
            <td>
                <button type="button" class="btn btn-outline" style="padding:6px 12px; font-size:0.8rem;" onclick='reprintPastInvoice(${JSON.stringify(inv).replace(/'/g, "&#39;")})'>
                    <i class="fa-solid fa-print"></i> Reprint Bill
                </button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

function reprintPastInvoice(invoiceGroup) {
    const rawSubtotal = invoiceGroup.items.reduce((s, i) => s + i.line_total, 0);
    const discountAmt = Math.max(0, rawSubtotal - invoiceGroup.total_bill);
    const discountPct = rawSubtotal > 0 ? ((discountAmt / rawSubtotal) * 100).toFixed(1) : 0;

    lastCompletedReceiptData = {
        invoice_no: invoiceGroup.invoice_no,
        sold_at: invoiceGroup.sold_at,
        counter_name: invoiceGroup.counter_name,
        cashier_username: invoiceGroup.cashier_username,
        customer_name: 'Walk-in Customer (Reprint)',
        customer_phone: '-',
        payment_method: 'Paid',
        subtotal: rawSubtotal,
        discount_pct: discountPct,
        discount_amt: discountAmt,
        grand_total: invoiceGroup.total_bill,
        cash_received: invoiceGroup.total_bill,
        change_due: 0,
        items: invoiceGroup.items
    };

    openReceiptModal(lastCompletedReceiptData);
}

// ==================== SHELF & STOCK LOOKUP TAB ====================
function renderShelfLookupTable() {
    const tbody = document.getElementById('shelf-lookup-tbody');
    const query = (document.getElementById('lookup-search-input').value || '').toLowerCase().trim();
    tbody.innerHTML = '';

    const filtered = availableBatches.filter(
        (b) =>
            (b.medicine_name || '').toLowerCase().includes(query) ||
            (b.rack_location || '').toLowerCase().includes(query) ||
            (b.batch_number || '').toLowerCase().includes(query)
    );

    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; color:#64748b;">No matching stock found.</td></tr>`;
        return;
    }

    filtered.forEach((b) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><strong>${escapeHtml(b.medicine_name)}</strong></td>
            <td>${escapeHtml(b.category || 'Tablet')}</td>
            <td><span class="badge badge-info"><i class="fa-solid fa-location-dot"></i> ${escapeHtml(b.rack_location || 'Main Shelf')}</span></td>
            <td><code>${escapeHtml(b.batch_number || 'N/A')}</code></td>
            <td><strong>${b.current_quantity}</strong> Units</td>
            <td><strong>LKR ${formatCurrency(b.selling_price)}</strong></td>
            <td>${escapeHtml(b.expiry_date)}</td>
            <td>
                <button type="button" class="btn btn-brand" style="padding:6px 12px; font-size:0.8rem;" onclick="addBatchToCart('${b.id}', 1); switchCashierTab('pos', document.querySelectorAll('.sidebar-nav .nav-item')[0]);">
                    <i class="fa-solid fa-cart-plus"></i> Add to Bill
                </button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

// ==================== FULL-OPTION RECEIPT MODAL & PRINT ENGINE ====================
function openReceiptModal(receiptData) {
    lastCompletedReceiptData = receiptData;
    document.getElementById('receipt-modal').classList.remove('hidden');
    applyReceiptOptions();
}

function closeReceiptModal() {
    document.getElementById('receipt-modal').classList.add('hidden');
}

function applyReceiptOptions() {
    if (!lastCompletedReceiptData || !currentPharmacy) return;

    const r = lastCompletedReceiptData;
    const paperSize = document.getElementById('opt-paper-size').value;
    const showHeader = document.getElementById('opt-show-header').checked;
    const showCustomer = document.getElementById('opt-show-customer').checked;
    const showBatch = document.getElementById('opt-show-batch').checked;
    const showDiscount = document.getElementById('opt-show-discount').checked;
    const showBarcode = document.getElementById('opt-show-barcode').checked;
    const footerNote = document.getElementById('opt-footer-note').value;

    const paperEl = document.getElementById('printable-receipt-paper');
    paperEl.className = `receipt-paper ${paperSize}`;

    const dateTimeStr = new Date(r.sold_at).toLocaleString('en-US', {
        year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit'
    });

    const itemsHtml = r.items.map((item) => `
        <tr>
            <td>
                <strong>${escapeHtml(item.medicine_name)}</strong>
                ${showBatch ? `<br><small style="color:#475569;">Batch: ${escapeHtml(item.batch_number)} | Exp: ${escapeHtml(item.expiry_date)}</small>` : ''}
            </td>
            <td style="text-align:center;">${item.qty}</td>
            <td style="text-align:right;">${formatCurrency(item.unit_price)}</td>
            <td style="text-align:right;"><strong>${formatCurrency(item.line_total)}</strong></td>
        </tr>
    `).join('');

    paperEl.innerHTML = `
        <div class="rcp-center">
            <div class="rcp-title">${escapeHtml(currentPharmacy.pharmacy_name)}</div>
            ${showHeader ? `
                <div>${escapeHtml(currentPharmacy.address)}, ${escapeHtml(currentPharmacy.city)}</div>
                <div>Tel: ${escapeHtml(currentPharmacy.phone || '-')} | Reg: ${escapeHtml(currentPharmacy.license_no)}</div>
            ` : ''}
        </div>

        <div class="rcp-divider"></div>

        <div class="rcp-meta-row">
            <span>Invoice: <strong>${escapeHtml(r.invoice_no)}</strong></span>
            <span>${escapeHtml(dateTimeStr)}</span>
        </div>
        <div class="rcp-meta-row">
            <span>Counter: ${escapeHtml(r.counter_name)}</span>
            <span>Cashier: ${escapeHtml(r.cashier_username)}</span>
        </div>

        ${showCustomer ? `
            <div class="rcp-meta-row" style="margin-top:4px;">
                <span>Customer: ${escapeHtml(r.customer_name)}</span>
                <span>Ref/Tel: ${escapeHtml(r.customer_phone)}</span>
            </div>
        ` : ''}

        <div class="rcp-divider"></div>

        <table class="rcp-table">
            <thead>
                <tr>
                    <th>Item Description</th>
                    <th style="text-align:center;">Qty</th>
                    <th style="text-align:right;">Rate</th>
                    <th style="text-align:right;">Amount</th>
                </tr>
            </thead>
            <tbody>
                ${itemsHtml}
            </tbody>
        </table>

        <div class="rcp-divider"></div>

        <div class="rcp-total-block">
            <div class="rcp-meta-row">
                <span>Subtotal:</span>
                <span>LKR ${formatCurrency(r.subtotal)}</span>
            </div>
            ${showDiscount && r.discount_amt > 0 ? `
                <div class="rcp-meta-row">
                    <span>Discount (${r.discount_pct}%):</span>
                    <span>- LKR ${formatCurrency(r.discount_amt)}</span>
                </div>
            ` : ''}
            <div class="rcp-meta-row" style="font-size:1rem; font-weight:800; margin:6px 0;">
                <span>NET TOTAL:</span>
                <span>LKR ${formatCurrency(r.grand_total)}</span>
            </div>
            <div class="rcp-meta-row">
                <span>Payment (${escapeHtml(r.payment_method)}):</span>
                <span>LKR ${formatCurrency(r.cash_received)}</span>
            </div>
            <div class="rcp-meta-row">
                <span>Change Returned:</span>
                <span>LKR ${formatCurrency(r.change_due)}</span>
            </div>
        </div>

        <div class="rcp-divider"></div>

        <div class="rcp-center" style="font-size:0.76rem; margin-top:8px;">
            ${escapeHtml(footerNote)}
        </div>

        ${showBarcode ? `
            <div class="rcp-barcode-Visual">
                ||| |||| || ||||| |||| |||<br>
                <small style="letter-spacing:1px; font-size:0.7rem;">*${escapeHtml(r.invoice_no)}*</small>
            </div>
        ` : ''}
    `;
}

function triggerBrowserPrint() {
    window.print();
}

// ==================== UI NAVIGATION & HELPERS ====================
function switchCashierTab(tabId, btnEl) {
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    document.querySelectorAll('.sidebar-nav .nav-item').forEach((b) => b.classList.remove('active'));

    document.getElementById(`tab-${tabId}`).classList.add('active');
    if (btnEl) btnEl.classList.add('active');
}

function logoutCashier() {
    sessionStorage.removeItem('pc_active_session');
    window.location.href = 'index.html';
}

function formatCurrency(val) {
    return Number(val || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `<i class="fa-solid ${type === 'error' ? 'fa-circle-exclamation' : 'fa-circle-check'}"></i><span>${escapeHtml(message)}</span>`;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}