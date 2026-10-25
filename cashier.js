/* ============================================================================
   PHARMACONNECT - POS CASHIER TERMINAL, ONLINE ORDER APPROVAL & RECEIPT ENGINE
   ============================================================================ */

// 1. STRICT SECURITY GATE
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
let allBatchesForLookup = [];
let todaySalesList = [];
let onlineOrdersList = [];
let pendingOnlineOrders = [];
let currentPendingOrderIndex = 0;

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
    subscribeToIncomingOnlineOrders();
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
    document.getElementById('pos-medicine-search').addEventListener('input', () => {
        renderPosMedicineGrid();
    });

    document.getElementById('pos-barcode-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            triggerBarcodeLookup();
        }
    });

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

// ==================== REALTIME LISTENER FOR INCOMING MEDIRADAR ORDERS ====================
function subscribeToIncomingOnlineOrders() {
    if (!currentPharmacy) return;

    supabaseClient
        .channel(`cashier-orders-${currentPharmacy.id}`)
        .on(
            'postgres_changes',
            {
                event: '*',
                schema: 'public',
                table: 'customer_orders',
                filter: `pharmacy_id=eq.${currentPharmacy.id}`
            },
            async (payload) => {
                if (payload.eventType === 'INSERT') {
                    showToast(`New MediRadar Online Order (${payload.new.invoice_no || 'New'}) received!`);
                }
                await refreshCashierData();
            }
        )
        .subscribe();

    // Poll every 6 seconds as backup so Cashier never misses an uploaded slip
    setInterval(() => {
        if (currentPharmacy) refreshCashierData(true);
    }, 6000);
}

// ==================== FETCH LIVE STOCK, ONLINE ORDERS & TODAY'S BUSINESS LOG ====================
async function refreshCashierData(silent = false) {
    if (!currentPharmacy) return;

    const todayStr = new Date().toISOString().split('T')[0];

    const [stockRes, salesRes, ordersRes] = await Promise.all([
        supabaseClient
            .from('grn_stock')
            .select('*')
            .eq('pharmacy_id', currentPharmacy.id)
            .order('expiry_date', { ascending: true }),
        supabaseClient
            .from('sales_transactions')
            .select('*')
            .eq('pharmacy_id', currentPharmacy.id)
            .order('sold_at', { ascending: false }),
        supabaseClient
            .from('customer_orders')
            .select('*, customer_order_items(*)')
            .eq('pharmacy_id', currentPharmacy.id)
            .order('created_at', { ascending: true }) // FIFO queue so earliest customer upload is reviewed first
    ]);

    const allStock = stockRes.data || [];
    allBatchesForLookup = allStock;
    availableBatches = allStock.filter((b) => b.current_quantity > 0 && b.expiry_date > todayStr);

    // Filter sales made Today (local date match + trailing 24h fallback)
    const allSales = salesRes.data || [];
    const now = new Date();
    todaySalesList = allSales.filter((s) => {
        if (!s.sold_at) return false;
        const saleDate = new Date(s.sold_at);
        return (
            saleDate.getFullYear() === now.getFullYear() &&
            saleDate.getMonth() === now.getMonth() &&
            saleDate.getDate() === now.getDate()
        );
    });

    onlineOrdersList = (ordersRes.data || []).slice().reverse(); // Newest first for history table
    pendingOnlineOrders = (ordersRes.data || []).filter(
        (o) => (o.cashier_approval_status || 'Pending') === 'Pending'
    );

    if (currentPendingOrderIndex >= pendingOnlineOrders.length) {
        currentPendingOrderIndex = Math.max(0, pendingOnlineOrders.length - 1);
    }

    const pendingBadge = document.getElementById('sidebar-online-pending-count');
    if (pendingBadge) {
        pendingBadge.textContent = pendingOnlineOrders.length;
    }

    if (!silent) {
        renderPosMedicineGrid();
        renderCart();
        renderShelfLookupTable();
    }
    renderTodayBusinessLog();
    renderOnlineOrdersReviewerAndTable();
}

// ==================== ONE-BY-ONE ONLINE ORDER & BANK SLIP REVIEWER ====================
function stepPendingOrder(delta) {
    if (pendingOnlineOrders.length === 0) return;
    currentPendingOrderIndex = (currentPendingOrderIndex + delta + pendingOnlineOrders.length) % pendingOnlineOrders.length;
    renderOnlineOrdersReviewerAndTable();
}

function inspectSpecificOrderInQueue(orderId) {
    const idx = pendingOnlineOrders.findIndex((o) => String(o.id) === String(orderId));
    if (idx > -1) {
        currentPendingOrderIndex = idx;
        renderOnlineOrdersReviewerAndTable();
        document.getElementById('one-by-one-reviewer-box').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

function renderOnlineOrdersReviewerAndTable() {
    const reviewerBox = document.getElementById('one-by-one-reviewer-box');
    const indicator = document.getElementById('queue-position-indicator');
    const tbody = document.getElementById('all-online-orders-tbody');

    if (pendingOnlineOrders.length === 0) {
        indicator.textContent = '0 Pending in Queue';
        reviewerBox.innerHTML = `
            <div style="text-align:center; padding:32px 20px; background:#f8fafc; border-radius:14px; border:1px dashed #cbd5e1; color:#15803d;">
                <i class="fa-solid fa-circle-check" style="font-size:2rem; margin-bottom:8px;"></i>
                <h4 style="margin:0; font-size:1rem;">All Caught Up! Zero Pending Bank Transfers in Queue</h4>
                <p style="font-size:0.84rem; color:#64748b; margin-top:4px;">When a customer uploads a bank receipt on MediRadar, it will appear here immediately for one-by-one verification.</p>
            </div>
        `;
    } else {
        const order = pendingOnlineOrders[currentPendingOrderIndex];
        indicator.textContent = `Reviewing Order ${currentPendingOrderIndex + 1} of ${pendingOnlineOrders.length}`;

        const items = order.customer_order_items || [];
        const itemsListHtml = items.map((item) => `
            <div style="display:flex; justify-content:space-between; padding:6px 0; border-bottom:1px solid #e2e8f0; font-size:0.88rem;">
                <span><strong>${item.quantity}x</strong> ${escapeHtml(item.medicine_name || 'Medicine')}</span>
                <strong>LKR ${formatCurrency(Number(item.quantity) * Number(item.unit_price))}</strong>
            </div>
        `).join('');

        const receiptPreviewHtml = order.receipt_image_url
            ? `
                <div style="text-align:center;">
                    <a href="${escapeHtml(order.receipt_image_url)}" target="_blank" title="Click to open full-size receipt in new tab">
                        <img src="${escapeHtml(order.receipt_image_url)}" alt="Bank Transfer Receipt"
                             style="max-height:280px; width:auto; max-width:100%; border-radius:12px; border:2px solid #cbd5e1; object-fit:contain; margin:0 auto; display:block;">
                    </a>
                    <a href="${escapeHtml(order.receipt_image_url)}" target="_blank" style="display:inline-block; margin-top:8px; font-size:0.8rem; font-weight:700; color:var(--brand-primary);">
                        <i class="fa-solid fa-magnifying-glass-plus"></i> Open Full-Size Receipt Image
                    </a>
                </div>
            `
            : `<div style="padding:40px; text-align:center; background:#f1f5f9; border-radius:12px; color:#64748b;">No receipt image attached (${escapeHtml(order.payment_method)})</div>`;

        reviewerBox.innerHTML = `
            <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap:20px; background:#f8fafc; padding:20px; border-radius:16px; border:1px solid #e2e8f0;">
                
                <!-- Left: Order & Customer Details -->
                <div style="display:flex; flex-direction:column; justify-content:space-between; gap:14px;">
                    <div>
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                            <span class="badge badge-warning" style="font-size:0.8rem;">Awaiting Verification</span>
                            <code style="font-size:0.95rem; font-weight:800;">${escapeHtml(order.invoice_no || order.id.slice(0, 8))}</code>
                        </div>

                        <h3 style="margin:0 0 4px 0; font-size:1.15rem;">Customer: ${escapeHtml(order.customer_name || 'MediRadar Customer')}</h3>
                        <p style="margin:0; font-size:0.85rem; color:#475569;">
                            <i class="fa-solid fa-phone"></i> ${escapeHtml(order.customer_phone || '-')} &nbsp;|&nbsp;
                            <i class="fa-solid fa-location-dot"></i> ${escapeHtml(order.delivery_address || '-')}
                        </p>

                        <div style="margin-top:12px; padding:12px; background:#fff; border-radius:12px; border:1px solid #e2e8f0;">
                            <div style="font-size:0.76rem; text-transform:uppercase; font-weight:800; color:#64748b; margin-bottom:4px;">Bank Transfer Details Submitted</div>
                            <div style="font-size:0.88rem;"><strong>Sending Bank:</strong> ${escapeHtml(order.sending_bank || 'Bank Transfer')}</div>
                            <div style="font-size:0.88rem;"><strong>Transfer Ref / Slip #:</strong> <code style="color:#0f766e; font-weight:800;">${escapeHtml(order.bank_reference || 'N/A')}</code></div>
                        </div>

                        <div style="margin-top:12px; padding:12px; background:#fff; border-radius:12px; border:1px solid #e2e8f0;">
                            <div style="font-size:0.76rem; text-transform:uppercase; font-weight:800; color:#64748b; margin-bottom:6px;">Ordered Medicines</div>
                            ${itemsListHtml || '<div>1x Medicine</div>'}
                            <div style="display:flex; justify-content:space-between; padding-top:8px; margin-top:6px; font-size:1.05rem; font-weight:800; color:var(--brand-primary);">
                                <span>Total Transfer Amount:</span>
                                <span>LKR ${formatCurrency(order.total_amount)}</span>
                            </div>
                        </div>
                    </div>

                    <!-- Accept / Reject Controls -->
                    <div style="display:flex; flex-direction:column; gap:10px;">
                        <input type="text" id="reject-reason-input" class="input-control" placeholder="Optional rejection reason (if rejecting slip)...">
                        <div style="display:flex; gap:10px; flex-wrap:wrap;">
                            <button type="button" id="btn-accept-order" class="btn btn-brand" style="flex:1;" onclick="handleCashierOrderDecision('${order.id}', 'Accepted')">
                                <i class="fa-solid fa-circle-check"></i> Accept Payment & Dispense Stock
                            </button>
                            <button type="button" id="btn-reject-order" class="btn btn-outline" style="color:var(--danger); border-color:var(--danger);" onclick="handleCashierOrderDecision('${order.id}', 'Rejected')">
                                <i class="fa-solid fa-circle-xmark"></i> Reject Slip
                            </button>
                        </div>
                    </div>
                </div>

                <!-- Right: Uploaded Bank Slip Preview -->
                <div style="display:flex; flex-direction:column; justify-content:center; background:#fff; padding:16px; border-radius:12px; border:1px solid #e2e8f0;">
                    <div style="font-size:0.78rem; font-weight:800; text-transform:uppercase; color:#64748b; margin-bottom:10px; text-align:center;">
                        <i class="fa-solid fa-file-invoice"></i> Customer Uploaded Bank Receipt Screenshot
                    </div>
                    ${receiptPreviewHtml}
                </div>

            </div>
        `;
    }

    // Populate All Online Orders Table
    tbody.innerHTML = '';
    if (onlineOrdersList.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:#64748b;">No MediRadar online orders received for this pharmacy yet.</td></tr>`;
        return;
    }

    onlineOrdersList.forEach((o) => {
        const dt = o.created_at ? new Date(o.created_at).toLocaleString() : '-';
        const items = o.customer_order_items || [];
        const itemsSummary = items.map((i) => `${escapeHtml(i.medicine_name || 'Medicine')} (x${i.quantity})`).join(', ');
        const status = o.cashier_approval_status || 'Pending';

        let statusHtml = '';
        if (status === 'Accepted') {
            statusHtml = `<span class="badge badge-success"><i class="fa-solid fa-check"></i> Accepted (${escapeHtml(o.reviewed_by || 'POS')})</span>`;
        } else if (status === 'Rejected') {
            statusHtml = `<span class="badge badge-danger"><i class="fa-solid fa-xmark"></i> Rejected</span>`;
        } else {
            statusHtml = `
                <button type="button" class="btn btn-brand" style="padding:5px 10px; font-size:0.76rem;" onclick="inspectSpecificOrderInQueue('${o.id}')">
                    <i class="fa-solid fa-eye"></i> Review in Queue
                </button>
            `;
        }

        const slipLink = o.receipt_image_url
            ? `<a href="${escapeHtml(o.receipt_image_url)}" target="_blank" style="color:var(--brand-primary); font-weight:700; font-size:0.78rem; display:block;"><i class="fa-solid fa-image"></i> View Slip</a>`
            : '';

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><small>${escapeHtml(dt)}</small></td>
            <td><code>${escapeHtml(o.invoice_no || o.id.slice(0, 8))}</code></td>
            <td>
                <strong>${escapeHtml(o.customer_name || 'Customer')}</strong>
                <small style="display:block; color:#64748b;">${escapeHtml(o.customer_phone || '')} • ${escapeHtml(o.delivery_address || '')}</small>
            </td>
            <td>${itemsSummary || 'Online Medicine Order'}</td>
            <td>
                <strong>${escapeHtml(o.payment_method)}</strong>
                <small style="display:block; color:#64748b;">${escapeHtml(o.bank_reference || '')}</small>
                ${slipLink}
            </td>
            <td><strong>LKR ${formatCurrency(o.total_amount)}</strong></td>
            <td>${statusHtml}</td>
        `;
        tbody.appendChild(tr);
    });
}

async function handleCashierOrderDecision(orderId, decision) {
    const order = onlineOrdersList.find((o) => String(o.id) === String(orderId));
    if (!order) return;

    const reasonInput = document.getElementById('reject-reason-input');
    const rejectionReason = reasonInput ? reasonInput.value.trim() : '';

    if (decision === 'Rejected' && !rejectionReason) {
        showToast('Please enter a brief rejection reason so the customer is informed.', 'error');
        if (reasonInput) reasonInput.focus();
        return;
    }

    const cashierUser = activeSession.username || activeSession.staff_name || 'cashier';
    const nowIso = new Date().toISOString();

    try {
        if (decision === 'Accepted') {
            const items = order.customer_order_items || [];

            // 1. Deduct each item from `grn_stock` and insert into `sales_transactions`
            for (const item of items) {
                const qty = Number(item.quantity || 1);
                const unitPrice = Number(item.unit_price || 0);

                // Find matching batch by grn_stock_id or medicine_name
                let batch = allBatchesForLookup.find((b) => String(b.id) === String(item.grn_stock_id));
                if (!batch && item.medicine_name) {
                    batch = allBatchesForLookup.find(
                        (b) => (b.medicine_name || '').toLowerCase() === item.medicine_name.toLowerCase() && b.current_quantity > 0
                    );
                }

                const unitCost = batch ? Number(batch.unit_cost || unitPrice * 0.72) : unitPrice * 0.72;
                const medName = item.medicine_name || (batch ? batch.medicine_name : 'Online Medicine');

                if (batch) {
                    const newQty = Math.max(0, Number(batch.current_quantity) - qty);
                    await supabaseClient
                        .from('grn_stock')
                        .update({ current_quantity: newQty })
                        .eq('id', batch.id);
                }

                await supabaseClient
                    .from('sales_transactions')
                    .insert([{
                        pharmacy_id: currentPharmacy.id,
                        invoice_no: order.invoice_no || `MR-${order.id.slice(0, 6).toUpperCase()}`,
                        counter_name: `MediRadar Online (Bank TX)`,
                        cashier_username: `${order.customer_name || 'Customer'} (Verified by ${cashierUser})`,
                        medicine_name: medName,
                        quantity_sold: qty,
                        unit_cost: unitCost,
                        unit_price: unitPrice,
                        total_amount: Number((qty * unitPrice).toFixed(2)),
                        profit_amount: Number((qty * (unitPrice - unitCost)).toFixed(2)),
                        sold_at: nowIso
                    }]);
            }

            // 2. Mark order as Accepted & Paid in `customer_orders` (Triggers live notification on MediRadar!)
            const { error: updErr } = await supabaseClient
                .from('customer_orders')
                .update({
                    cashier_approval_status: 'Accepted',
                    payment_status: 'Paid',
                    order_status: 'Ready for Pickup',
                    reviewed_by: cashierUser,
                    reviewed_at: nowIso
                })
                .eq('id', order.id);

            if (updErr) throw updErr;

            showToast(`Order ${order.invoice_no || ''} Accepted! Stock deducted & customer notified on MediRadar.`);
        } else {
            // Rejected
            const { error: rejErr } = await supabaseClient
                .from('customer_orders')
                .update({
                    cashier_approval_status: 'Rejected',
                    payment_status: 'Failed',
                    order_status: 'Cancelled',
                    rejection_reason: rejectionReason,
                    reviewed_by: cashierUser,
                    reviewed_at: nowIso
                })
                .eq('id', order.id);

            if (rejErr) throw rejErr;

            showToast(`Order ${order.invoice_no || ''} Rejected. Customer has been notified.`, 'error');
        }

        await refreshCashierData();
    } catch (err) {
        console.error('Order review error:', err);
        showToast(err.message || 'Failed to update order status.', 'error');
    }
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
        const matchesCat = selectedCategory === 'ALL' || (b.category || '').toLowerCase().includes(selectedCategory.toLowerCase());
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

// ==================== FINALIZE SALE ====================
async function finalizeSaleAndPrint() {
    if (cart.length === 0) {
        showToast('Please add at least one medicine to the bill before checkout!', 'error');
        return;
    }

    const { subtotal, discPct, discountAmt, grandTotal } = recalculateCartTotals();
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
        for (const item of cart) {
            const newQty = Math.max(0, Number(item.batch.current_quantity) - item.qty);
            const { error: stockErr } = await supabaseClient
                .from('grn_stock')
                .update({ current_quantity: newQty })
                .eq('id', item.batch.id)
                .eq('pharmacy_id', currentPharmacy.id);

            if (stockErr) throw stockErr;
        }

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

// ==================== TODAY'S BUSINESS LOG TAB (POS + MEDIRADAR ONLINE) ====================
function isOnlineRow(row) {
    const c = (row.counter_name || '').toLowerCase();
    return c.includes('mediradar') || c.includes('web') || c.includes('online');
}

function renderTodayBusinessLog() {
    const filterMode = document.getElementById('daylog-counter-filter').value;
    const myCounter = activeSession.counter_name || 'Counter 01';

    const filteredRows = todaySalesList.filter((s) => {
        if (filterMode === 'MY_COUNTER') return s.counter_name === myCounter;
        if (filterMode === 'MEDIRADAR_ONLY') return isOnlineRow(s);
        return true; // ALL_COUNTERS
    });

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
        tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:#64748b;">No sales recorded for today yet. Complete an order in the POS Terminal or accept a MediRadar online order to see it logged here.</td></tr>`;
        return;
    }

    invoicesArray.forEach((inv) => {
        const timeStr = new Date(inv.sold_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        const itemSummary = inv.items.map((i) => `${escapeHtml(i.medicine_name)} (x${i.qty})`).join(', ');
        const isWeb = isOnlineRow(inv);

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><strong>${timeStr}</strong></td>
            <td><code>${escapeHtml(inv.invoice_no)}</code></td>
            <td>
                <span class="badge ${isWeb ? 'badge-success' : 'badge-info'}">${escapeHtml(inv.counter_name)}</span>
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
        customer_name: invoiceGroup.cashier_username || 'Customer (Reprint)',
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