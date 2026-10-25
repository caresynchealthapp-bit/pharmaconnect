/* ============================================================================
   PHARMACONNECT - DYNAMIC MULTI-TENANT ADMIN CONTROLLER
   (Includes Multi-Bank Management & MediRadar Online Deals Financial Overview)
   ============================================================================ */

// 1. STRICT SECURITY GATE
const activeSession = JSON.parse(sessionStorage.getItem('pc_active_session') || 'null');
const urlParams = new URLSearchParams(window.location.search);
const pId = urlParams.get('pharmacy_id');

if (!activeSession || !pId || String(activeSession.pharmacy_id) !== String(pId) || activeSession.role !== 'admin') {
    window.location.href = 'index.html';
    throw new Error('Security Exception: Unauthorized access blocked. Redirecting to Hub.');
}

// 2. SUPABASE CONFIGURATION
const SUPABASE_URL = 'https://juobkaftyrzlxbviudpy.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_qdME8AYk9rz5B4FHs4Eb1g_0vvhN73v';

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ==================== ENCRYPTION HELPERS ====================
const SECRET_KEY = "PC_SECURE_2026_";

function encryptPassword(pwd) {
    return btoa(SECRET_KEY + pwd).split('').reverse().join('');
}

function decryptPassword(encPwd) {
    try {
        const decoded = atob(encPwd.split('').reverse().join(''));
        if (decoded.startsWith(SECRET_KEY)) {
            return decoded.replace(SECRET_KEY, '');
        }
        return encPwd; 
    } catch (e) {
        return encPwd; 
    }
}

window.togglePasswordVisibility = function(btnElement, encryptedPwd) {
    const codeEl = btnElement.previousElementSibling;
    const icon = btnElement.querySelector('i');
    
    if (codeEl.getAttribute('data-hidden') === 'true') {
        codeEl.textContent = decryptPassword(encryptedPwd);
        codeEl.setAttribute('data-hidden', 'false');
        codeEl.style.letterSpacing = 'normal';
        icon.classList.replace('fa-eye', 'fa-eye-slash');
    } else {
        codeEl.textContent = '••••••••';
        codeEl.setAttribute('data-hidden', 'true');
        codeEl.style.letterSpacing = '2px';
        icon.classList.replace('fa-eye-slash', 'fa-eye');
    }
};

// Dynamic Per-Pharmacy Theme Palettes
const PHARMACY_THEMES = [
    { primary: '#0d9488', secondary: '#0284c7', soft: '#ccfbf1', sidebar: '#0f172a' },
    { primary: '#4f46e5', secondary: '#7c3aed', soft: '#e0e7ff', sidebar: '#1e1b4b' },
    { primary: '#e11d48', secondary: '#ea580c', soft: '#ffe4e6', sidebar: '#270915' },
    { primary: '#d97706', secondary: '#059669', soft: '#fef3c7', sidebar: '#1c1917' }
];

let currentPharmacy = null;
let staffRecords = [];
let grnBatches = [];
let salesRecords = [];
let medicineCatalog = [];
let pharmacyBanksList = [];
let mediRadarOrders = [];

let cashflowChartInstance = null;
let topMedicinesChartInstance = null;

// ==================== INITIALIZATION ====================
document.addEventListener('DOMContentLoaded', async () => {
    try {
        await loadTenantPharmacyDetails(pId);
        setupAdminListeners();
        await refreshAllAdminData();
        subscribeToAdminRealtime();
    } catch (err) {
        showToast('Error loading dashboard data. Check console.', 'error');
    }
});

async function loadTenantPharmacyDetails(pharmacyId) {
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

    document.title = `${data.pharmacy_name} | Admin Console`;
    document.getElementById('sidebar-pharmacy-name').textContent = data.pharmacy_name;
    document.getElementById('sidebar-pharmacy-license').textContent = `REG: ${data.license_no}`;
    document.getElementById('sidebar-pharmacy-city').textContent = `${data.address}, ${data.city}`;
    document.getElementById('session-admin-name').textContent = data.admin_username;
    
    const bannerEl = document.getElementById('sidebar-banner');
    if (bannerEl && data.image_url) {
        bannerEl.style.backgroundImage = `url('${data.image_url}')`;
    }
    document.getElementById('link-open-grn').href = `grn.html?pharmacy_id=${encodeURIComponent(data.id)}`;

    const savedThemeIdx = localStorage.getItem(`theme_${data.id}`);
    const hashIdx = data.pharmacy_name.length % PHARMACY_THEMES.length;
    applyPharmacyTheme(savedThemeIdx !== null ? Number(savedThemeIdx) : hashIdx);
}

function applyPharmacyTheme(themeIndex) {
    const theme = PHARMACY_THEMES[themeIndex] || PHARMACY_THEMES[0];
    const root = document.documentElement;
    root.style.setProperty('--brand-primary', theme.primary);
    root.style.setProperty('--brand-secondary', theme.secondary);
    root.style.setProperty('--brand-soft', theme.soft);
    root.style.setProperty('--sidebar-bg', theme.sidebar);

    if (currentPharmacy) {
        localStorage.setItem(`theme_${currentPharmacy.id}`, themeIndex);
    }
    if (cashflowChartInstance || topMedicinesChartInstance) {
        renderDashboardAnalytics();
    }
}

function setupAdminListeners() {
    document.getElementById('create-staff-form').addEventListener('submit', handleCreateStaff);
    document.getElementById('add-medicine-catalog-form').addEventListener('submit', handleAddCatalogMedicine);
    document.getElementById('bank-account-form').addEventListener('submit', handleSaveBankAccount);
}

function subscribeToAdminRealtime() {
    if (!currentPharmacy) return;
    supabaseClient
        .channel(`admin-live-${currentPharmacy.id}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'sales_transactions', filter: `pharmacy_id=eq.${currentPharmacy.id}` }, () => refreshAllAdminData())
        .on('postgres_changes', { event: '*', schema: 'public', table: 'customer_orders', filter: `pharmacy_id=eq.${currentPharmacy.id}` }, () => refreshAllAdminData())
        .subscribe();
}

// ==================== LOAD ALL PHARMACY-ISOLATED DATA ====================
async function refreshAllAdminData() {
    if (!currentPharmacy) return;

    const [staffRes, grnRes, salesRes, medRes, banksRes, ordersRes] = await Promise.all([
        supabaseClient.from('pharmacy_staff').select('*').eq('pharmacy_id', currentPharmacy.id).order('created_at', { ascending: false }),
        supabaseClient.from('grn_stock').select('*').eq('pharmacy_id', currentPharmacy.id).order('created_at', { ascending: false }),
        supabaseClient.from('sales_transactions').select('*').eq('pharmacy_id', currentPharmacy.id).order('sold_at', { ascending: false }),
        supabaseClient.from('medicines').select('*').eq('pharmacy_id', currentPharmacy.id).order('name', { ascending: true }),
        supabaseClient.from('pharmacy_banks').select('*').eq('pharmacy_id', currentPharmacy.id).order('created_at', { ascending: true }),
        supabaseClient.from('customer_orders').select('*, customer_order_items(*)').eq('pharmacy_id', currentPharmacy.id).order('created_at', { ascending: false })
    ]);

    staffRecords = staffRes.data || [];
    grnBatches = grnRes.data || [];
    salesRecords = salesRes.data || [];
    medicineCatalog = medRes.data || [];
    pharmacyBanksList = banksRes.data || [];
    mediRadarOrders = ordersRes.data || [];

    // If pharmacy has legacy bank columns in `pharmacies` but `pharmacy_banks` is empty, seed it automatically
    if (pharmacyBanksList.length === 0 && currentPharmacy.bank_name && currentPharmacy.account_number) {
        const { data: seededBank } = await supabaseClient
            .from('pharmacy_banks')
            .insert([{
                pharmacy_id: currentPharmacy.id,
                bank_name: currentPharmacy.bank_name,
                branch_name: currentPharmacy.bank_branch || currentPharmacy.city || 'Main Branch',
                account_name: currentPharmacy.account_name || currentPharmacy.pharmacy_name,
                account_number: currentPharmacy.account_number
            }])
            .select();
        if (seededBank) pharmacyBanksList = seededBank;
    }

    populateCounterFilterDropdown();
    renderDashboardAnalytics();
    renderBanksTable();
    renderStaffTable();
    renderCatalogTable();
}

// ==================== BANKING DETAILS MANAGEMENT (`pharmacy_banks`) ====================
async function handleSaveBankAccount(e) {
    e.preventDefault();
    if (!currentPharmacy) return;

    const editId = document.getElementById('edit-bank-id').value.trim();
    const bankName = document.getElementById('bank-name-input').value.trim();
    const branchName = document.getElementById('bank-branch-input').value.trim();
    const accountName = document.getElementById('bank-holder-input').value.trim();
    const accountNumber = document.getElementById('bank-number-input').value.trim();

    const btn = document.getElementById('btn-save-bank');
    btn.disabled = true;

    try {
        if (editId) {
            const { error } = await supabaseClient
                .from('pharmacy_banks')
                .update({
                    bank_name: bankName,
                    branch_name: branchName,
                    account_name: accountName,
                    account_number: accountNumber
                })
                .eq('id', editId)
                .eq('pharmacy_id', currentPharmacy.id);
            if (error) throw error;
            showToast(`Updated bank account (${bankName})!`);
        } else {
            const { error } = await supabaseClient
                .from('pharmacy_banks')
                .insert([{
                    pharmacy_id: currentPharmacy.id,
                    bank_name: bankName,
                    branch_name: branchName,
                    account_name: accountName,
                    account_number: accountNumber
                }]);
            if (error) throw error;
            showToast(`Added ${bankName} account to MediRadar checkout!`);
        }

        // Also keep the primary bank columns on `public.pharmacies` synced for backward compatibility
        await supabaseClient
            .from('pharmacies')
            .update({
                bank_name: bankName,
                bank_branch: branchName,
                account_name: accountName,
                account_number: accountNumber
            })
            .eq('id', currentPharmacy.id);

        resetBankForm();
        await refreshAllAdminData();
    } catch (err) {
        showToast(err.message || 'Failed to save bank account.', 'error');
    } finally {
        btn.disabled = false;
    }
}

function startEditBankAccount(bankId) {
    const bank = pharmacyBanksList.find((b) => String(b.id) === String(bankId));
    if (!bank) return;

    document.getElementById('edit-bank-id').value = bank.id;
    document.getElementById('bank-name-input').value = bank.bank_name || '';
    document.getElementById('bank-branch-input').value = bank.branch_name || '';
    document.getElementById('bank-holder-input').value = bank.account_name || '';
    document.getElementById('bank-number-input').value = bank.account_number || '';

    document.getElementById('btn-save-bank').innerHTML = '<i class="fa-solid fa-pen-to-square"></i> Update Bank Account';
    document.getElementById('btn-cancel-bank-edit').classList.remove('hidden');
}

function resetBankForm() {
    document.getElementById('bank-account-form').reset();
    document.getElementById('edit-bank-id').value = '';
    document.getElementById('btn-save-bank').innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save Bank Account';
    document.getElementById('btn-cancel-bank-edit').classList.add('hidden');
}

async function deleteBankAccount(bankId) {
    if (!confirm('Remove this bank account from your pharmacy profile and MediRadar checkout?')) return;

    const { error } = await supabaseClient
        .from('pharmacy_banks')
        .delete()
        .eq('id', bankId)
        .eq('pharmacy_id', currentPharmacy.id);

    if (error) {
        showToast(error.message, 'error');
        return;
    }
    showToast('Bank account removed.');
    await refreshAllAdminData();
}

function renderBanksTable() {
    const tbody = document.getElementById('pharmacy-banks-tbody');
    const badge = document.getElementById('sidebar-bank-count');
    if (badge) badge.textContent = pharmacyBanksList.length;

    tbody.innerHTML = '';

    if (pharmacyBanksList.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:#64748b;">No bank accounts added yet. Add your pharmacy bank account above so customers can pay via Bank Transfer on MediRadar.</td></tr>`;
        return;
    }

    pharmacyBanksList.forEach((b) => {
        const dateStr = b.created_at ? new Date(b.created_at).toLocaleDateString() : '-';
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><strong><i class="fa-solid fa-building-columns" style="color:var(--brand-primary); margin-right:6px;"></i>${escapeHtml(b.bank_name)}</strong></td>
            <td>${escapeHtml(b.branch_name || 'Main Branch')}</td>
            <td>${escapeHtml(b.account_name)}</td>
            <td><code style="font-size:0.95rem; font-weight:700;">${escapeHtml(b.account_number)}</code></td>
            <td>${escapeHtml(dateStr)}</td>
            <td>
                <div style="display:flex; gap:8px;">
                    <button type="button" class="btn btn-outline" style="padding:6px 10px;" onclick="startEditBankAccount('${b.id}')" title="Edit Bank Account">
                        <i class="fa-solid fa-pen"></i> Edit
                    </button>
                    <button type="button" class="btn btn-outline" style="padding:6px 10px; color:var(--danger); border-color:var(--danger);" onclick="deleteBankAccount('${b.id}')" title="Delete Bank Account">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

// ==================== COUNTER & TIME FILTERS & DASHBOARD CHARTS ====================
function isOnlineMediRadarSale(saleRow) {
    const c = (saleRow.counter_name || '').toLowerCase();
    return c.includes('mediradar') || c.includes('web') || c.includes('online');
}

function populateCounterFilterDropdown() {
    const select = document.getElementById('counter-filter-select');
    const previousValue = select.value || 'ALL';

    const counterSet = new Set();
    staffRecords.filter((s) => s.role === 'cashier').forEach((s) => {
        if (s.counter_name) counterSet.add(s.counter_name);
    });
    salesRecords.forEach((sale) => {
        if (sale.counter_name) counterSet.add(sale.counter_name);
    });

    select.innerHTML = `
        <option value="ALL">All Channels (POS Counters + MediRadar Online)</option>
        <option value="MEDIRADAR_ONLY">🌐 MediRadar Online Deals Only</option>
    `;
    Array.from(counterSet).sort().forEach((counter) => {
        const opt = document.createElement('option');
        opt.value = counter;
        opt.textContent = `${counter}`;
        select.appendChild(opt);
    });

    if ([...select.options].some((o) => o.value === previousValue)) {
        select.value = previousValue;
    }
}

function renderDashboardAnalytics() {
    const selectedCounter = document.getElementById('counter-filter-select').value;
    const selectedTime = document.getElementById('time-filter-select').value;

    const now = new Date();
    let startTime = new Date(0);

    if (selectedTime === 'TODAY') {
        startTime = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    } else if (selectedTime === 'WEEK') {
        startTime = new Date();
        startTime.setDate(now.getDate() - 7);
    } else if (selectedTime === 'MONTH') {
        startTime = new Date(now.getFullYear(), now.getMonth(), 1);
    }

    const filteredSales = salesRecords.filter((s) => {
        const matchCounter =
            selectedCounter === 'ALL' ? true :
            selectedCounter === 'MEDIRADAR_ONLY' ? isOnlineMediRadarSale(s) :
            s.counter_name === selectedCounter;
        const saleDate = new Date(s.sold_at);
        const matchTime = saleDate >= startTime;
        return matchCounter && matchTime;
    });

    const timeFilteredGrnBatches = grnBatches.filter((b) => {
        const batchDate = new Date(b.created_at);
        return batchDate >= startTime;
    });

    const timeFilteredOnlineOrders = mediRadarOrders.filter((o) => {
        const orderDate = new Date(o.created_at);
        return orderDate >= startTime;
    });

    const timeLabel = selectedTime === 'ALL' ? 'All Time' :
                      selectedTime === 'TODAY' ? 'Today' :
                      selectedTime === 'WEEK' ? 'Last 7 Days' : 'This Month';

    document.getElementById('counter-sales-summary-badge').textContent =
        `${filteredSales.length} Sale Items Filtered (${timeLabel})`;

    // Calculate Dynamic KPIs
    const totalSalesRevenue = filteredSales.reduce((acc, s) => acc + Number(s.total_amount || 0), 0);
    const totalSalesProfit = filteredSales.reduce((acc, s) => acc + Number(s.profit_amount || 0), 0);
    const totalGrnExpenses = timeFilteredGrnBatches.reduce((acc, b) => acc + (Number(b.quantity_received || 0) * Number(b.unit_cost || 0)), 0);
    const activeStockValuation = grnBatches.reduce((acc, b) => acc + (Number(b.current_quantity || 0) * Number(b.selling_price || 0)), 0);

    // MediRadar Online Deals KPI (Accepted/Paid online orders + Web sales_transactions)
    const onlineSalesFromTx = filteredSales.filter(isOnlineMediRadarSale).reduce((acc, s) => acc + Number(s.total_amount || 0), 0);
    const pendingOnlineCount = timeFilteredOnlineOrders.filter((o) => (o.cashier_approval_status || 'Pending') === 'Pending').length;
    const acceptedOnlineCount = timeFilteredOnlineOrders.filter((o) => o.cashier_approval_status === 'Accepted' || o.payment_status === 'Paid').length;

    const todayStr = new Date().toISOString().split('T')[0];
    const expiredCount = grnBatches.filter((b) => b.expiry_date <= todayStr && b.current_quantity > 0).length;

    const profitMargin = totalSalesRevenue > 0 ? ((totalSalesProfit / totalSalesRevenue) * 100).toFixed(1) : '0.0';

    document.getElementById('kpi-cash-inflow').textContent = `LKR ${formatCurrency(totalSalesRevenue)}`;
    document.getElementById('kpi-sales-count').textContent = `Across ${filteredSales.length} dispensed items`;
    document.getElementById('kpi-mediradar-sales').textContent = `LKR ${formatCurrency(onlineSalesFromTx)}`;
    document.getElementById('kpi-mediradar-count').textContent = `${acceptedOnlineCount} accepted • ${pendingOnlineCount} pending review`;
    document.getElementById('kpi-grn-expenses').textContent = `LKR ${formatCurrency(totalGrnExpenses)}`;
    document.getElementById('kpi-grn-batches').textContent = `${timeFilteredGrnBatches.length} batches recorded in period`;
    document.getElementById('kpi-net-profit').textContent = `LKR ${formatCurrency(totalSalesProfit)}`;
    document.getElementById('kpi-profit-margin').textContent = `Gross Margin: ${profitMargin}%`;
    document.getElementById('kpi-stock-value').textContent = `LKR ${formatCurrency(activeStockValuation)}`;
    document.getElementById('kpi-expired-warning').textContent = `${expiredCount} expired batches requiring removal`;

    renderCharts(filteredSales, timeFilteredGrnBatches);
    renderCounterBreakdownTable(filteredSales);
    renderMediRadarDealsTable(timeFilteredOnlineOrders);
}

function isSameLocalDay(dateStr, refDate) {
    if (!dateStr) return false;
    const d = new Date(dateStr);
    return (
        d.getFullYear() === refDate.getFullYear() &&
        d.getMonth() === refDate.getMonth() &&
        d.getDate() === refDate.getDate()
    );
}

function renderCharts(filteredSales, timeFilteredGrnBatches) {
    const primaryColor = getComputedStyle(document.documentElement).getPropertyValue('--brand-primary').trim() || '#0d9488';
    const secondaryColor = getComputedStyle(document.documentElement).getPropertyValue('--brand-secondary').trim() || '#0284c7';

    const dayLabels = [];
    const revenueSeries = [];
    const profitSeries = [];
    const expenseSeries = [];

    for (let i = 5; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        dayLabels.push(label);

        const daySales = filteredSales.filter((s) => isSameLocalDay(s.sold_at, d));
        const dayGrn = timeFilteredGrnBatches.filter((b) => isSameLocalDay(b.created_at, d));

        revenueSeries.push(daySales.reduce((sum, s) => sum + Number(s.total_amount || 0), 0));
        profitSeries.push(daySales.reduce((sum, s) => sum + Number(s.profit_amount || 0), 0));
        expenseSeries.push(dayGrn.reduce((sum, b) => sum + (Number(b.quantity_received || 0) * Number(b.unit_cost || 0)), 0));
    }

    const ctxCash = document.getElementById('cashflowChart').getContext('2d');
    if (cashflowChartInstance) cashflowChartInstance.destroy();

    cashflowChartInstance = new Chart(ctxCash, {
        type: 'bar',
        data: {
            labels: dayLabels,
            datasets: [
                { label: 'Cash Inflow (POS + MediRadar LKR)', data: revenueSeries, backgroundColor: primaryColor, borderRadius: 6 },
                { label: 'GRN Stock Expenses (LKR)', data: expenseSeries, backgroundColor: '#ef4444', borderRadius: 6 },
                { label: 'Gross Profit (LKR)', data: profitSeries, backgroundColor: '#10b981', borderRadius: 6 }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { position: 'top' } },
            scales: { y: { beginAtZero: true } }
        }
    });

    const medTotals = {};
    filteredSales.forEach((sale) => {
        const name = sale.medicine_name || 'Unknown';
        medTotals[name] = (medTotals[name] || 0) + Number(sale.quantity_sold || 0);
    });

    const sortedMeds = Object.entries(medTotals).sort((a, b) => b[1] - a[1]).slice(0, 6);
    const medLabels = sortedMeds.length > 0 ? sortedMeds.map((i) => i[0]) : ['No Sales Found in Period'];
    const medQuantities = sortedMeds.length > 0 ? sortedMeds.map((i) => i[1]) : [0];

    const ctxTop = document.getElementById('topMedicinesChart').getContext('2d');
    if (topMedicinesChartInstance) topMedicinesChartInstance.destroy();

    topMedicinesChartInstance = new Chart(ctxTop, {
        type: 'bar',
        data: {
            labels: medLabels,
            datasets: [{
                label: 'Units Sold',
                data: medQuantities,
                backgroundColor: [primaryColor, secondaryColor, '#10b981', '#f59e0b', '#8b5cf6', '#ec4899'],
                borderRadius: 6
            }]
        },
        options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: { x: { beginAtZero: true } }
        }
    });
}

function renderCounterBreakdownTable(filteredSalesData) {
    const tbody = document.getElementById('counter-performance-tbody');
    tbody.innerHTML = '';

    const counterMap = {};
    const selectedCounter = document.getElementById('counter-filter-select').value;

    if (selectedCounter !== 'MEDIRADAR_ONLY') {
        staffRecords.filter((s) => s.role === 'cashier').forEach((s) => {
            const key = s.counter_name || 'Unassigned Counter';
            if (selectedCounter === 'ALL' || key === selectedCounter) {
                counterMap[key] = {
                    counter_name: key,
                    cashier_username: s.username,
                    bills: 0,
                    units: 0,
                    revenue: 0,
                    profit: 0
                };
            }
        });
    }

    filteredSalesData.forEach((s) => {
        const key = s.counter_name || 'Main Counter';
        if (!counterMap[key]) {
            counterMap[key] = { counter_name: key, cashier_username: s.cashier_username || 'cashier', bills: 0, units: 0, revenue: 0, profit: 0 };
        }
        counterMap[key].bills += 1;
        counterMap[key].units += Number(s.quantity_sold || 0);
        counterMap[key].revenue += Number(s.total_amount || 0);
        counterMap[key].profit += Number(s.profit_amount || 0);
    });

    const rows = Object.values(counterMap);
    if (rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:#64748b;">No sales recorded for this period.</td></tr>`;
        return;
    }

    rows.forEach((row) => {
        const isOnline = isOnlineMediRadarSale(row);
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>
                <strong>${escapeHtml(row.counter_name)}</strong>
                ${isOnline ? `<span class="badge badge-info" style="margin-left:6px;">MediRadar Web</span>` : ''}
            </td>
            <td><code>${escapeHtml(row.cashier_username)}</code></td>
            <td><span class="badge badge-info">${row.bills} Sales</span></td>
            <td>${row.units} Units</td>
            <td><strong>LKR ${formatCurrency(row.revenue)}</strong></td>
            <td><span class="badge badge-success">+ LKR ${formatCurrency(row.profit)}</span></td>
        `;
        tbody.appendChild(tr);
    });
}

function renderMediRadarDealsTable(ordersList) {
    const tbody = document.getElementById('mediradar-deals-tbody');
    const badge = document.getElementById('mediradar-ledger-badge');
    if (badge) badge.textContent = `${ordersList.length} Online Orders`;

    tbody.innerHTML = '';

    if (ordersList.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:#64748b;">No MediRadar online customer orders recorded in this period yet.</td></tr>`;
        return;
    }

    ordersList.forEach((o) => {
        const dt = o.created_at ? new Date(o.created_at).toLocaleString() : '-';
        const items = o.customer_order_items || [];
        const itemsText = items.length > 0
            ? items.map((i) => `${escapeHtml(i.medicine_name || 'Medicine')} (x${i.quantity})`).join(', ')
            : 'Online Order Items';

        const approval = o.cashier_approval_status || 'Pending';
        let statusHtml = `<span class="badge badge-warning">Pending Cashier Review</span>`;
        if (approval === 'Accepted') {
            statusHtml = `<span class="badge badge-success">Accepted (${escapeHtml(o.reviewed_by || 'POS')})</span>`;
        } else if (approval === 'Rejected') {
            statusHtml = `<span class="badge badge-danger">Rejected (${escapeHtml(o.rejection_reason || 'Invalid Slip')})</span>`;
        }

        const slipLink = o.receipt_image_url
            ? `<br><a href="${escapeHtml(o.receipt_image_url)}" target="_blank" style="color:var(--brand-primary); font-weight:700; font-size:0.78rem;"><i class="fa-solid fa-image"></i> View Bank Slip</a>`
            : '';

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><small>${escapeHtml(dt)}</small></td>
            <td><code>${escapeHtml(o.invoice_no || o.id.slice(0, 8))}</code></td>
            <td>
                <strong>${escapeHtml(o.customer_name || 'MediRadar Customer')}</strong>
                <small style="display:block; color:#64748b;">Tel: ${escapeHtml(o.customer_phone || '-')} • ${escapeHtml(o.delivery_address || '-')}</small>
            </td>
            <td>${itemsText}</td>
            <td>
                <strong>${escapeHtml(o.payment_method || 'Card')}</strong>
                <small style="display:block; color:#64748b;">${escapeHtml(o.bank_reference || '')}</small>
                ${slipLink}
            </td>
            <td><strong>LKR ${formatCurrency(o.total_amount)}</strong></td>
            <td>${statusHtml}</td>
        `;
        tbody.appendChild(tr);
    });
}

// ==================== STAFF & COUNTER MANAGEMENT ====================
function toggleCounterField() {
    const role = document.getElementById('staff-role').value;
    const label = document.getElementById('staff-counter-label');
    const input = document.getElementById('staff-counter');

    if (role === 'cashier') {
        label.textContent = 'Assigned Counter Number *';
        input.placeholder = 'e.g., Counter 01';
        input.value = '';
    } else {
        label.textContent = 'Assigned GRN Station *';
        input.placeholder = 'e.g., GRN Intake Desk 01';
        input.value = 'GRN Intake Desk';
    }
}

async function handleCreateStaff(e) {
    e.preventDefault();
    if (!currentPharmacy) return;

    const fullName = document.getElementById('staff-fullname').value.trim();
    const role = document.getElementById('staff-role').value;
    const counterName = document.getElementById('staff-counter').value.trim();
    const username = document.getElementById('staff-username').value.trim();
    const rawPassword = document.getElementById('staff-password').value.trim();

    const btn = document.getElementById('btn-save-staff');
    btn.disabled = true;

    try {
        const encryptedPassword = encryptPassword(rawPassword);

        const { error } = await supabaseClient
            .from('pharmacy_staff')
            .insert([{
                pharmacy_id: currentPharmacy.id,
                full_name: fullName,
                role: role,
                counter_name: counterName,
                username: username,
                password: encryptedPassword,
                is_active: true
            }]);

        if (error) throw error;

        document.getElementById('create-staff-form').reset();
        showToast(`Created ${role.toUpperCase()} account "${username}" for ${counterName}!`);
        await refreshAllAdminData();
    } catch (err) {
        showToast(err.message || 'Failed to create staff credentials.', 'error');
    } finally {
        btn.disabled = false;
    }
}

function renderStaffTable() {
    const tbody = document.getElementById('staff-list-tbody');
    tbody.innerHTML = '';

    if (staffRecords.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:#64748b;">No Cashier or GRN staff accounts created for ${escapeHtml(currentPharmacy.pharmacy_name)} yet.</td></tr>`;
        return;
    }

    staffRecords.forEach((staff) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><strong>${escapeHtml(staff.full_name)}</strong></td>
            <td>
                <span class="badge ${staff.role === 'cashier' ? 'badge-info' : 'badge-warning'}">
                    ${staff.role === 'cashier' ? 'POS Cashier' : 'GRN System'}
                </span>
            </td>
            <td>${escapeHtml(staff.counter_name || '---')}</td>
            <td><code>${escapeHtml(staff.username)}</code></td>
            <td>
                <div style="display:flex; align-items:center; gap:8px;">
                    <code data-hidden="true" style="font-size:1.1rem; letter-spacing:2px; min-width:80px; display:inline-block; border-radius:6px;">••••••••</code>
                    <button class="btn btn-outline" style="padding:4px 10px; border:none; background:transparent;" onclick="togglePasswordVisibility(this, '${staff.password}')" title="Reveal Password">
                        <i class="fa-solid fa-eye" style="color:#64748b;"></i>
                    </button>
                </div>
            </td>
            <td><span class="badge badge-success">Active</span></td>
            <td>
                <button class="btn btn-outline" style="padding: 6px 10px; color: var(--danger); border-color: var(--danger);" onclick="deleteStaffAccount('${staff.id}')">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

async function deleteStaffAccount(staffId) {
    if (!confirm('Are you sure you want to delete this staff login?')) return;
    const { error } = await supabaseClient.from('pharmacy_staff').delete().eq('id', staffId);
    if (error) {
        showToast(error.message, 'error');
        return;
    }
    showToast('Staff credential removed.');
    await refreshAllAdminData();
}

// ==================== MASTER MEDICINE CATALOG (`medicines` TABLE) ====================
async function handleAddCatalogMedicine(e) {
    e.preventDefault();
    const nameInput = document.getElementById('catalog-medicine-name');
    const medName = nameInput.value.trim();
    if (!medName || !currentPharmacy) return;

    try {
        const { error } = await supabaseClient
            .from('medicines')
            .insert([{ name: medName, pharmacy_id: currentPharmacy.id }]);

        if (error) throw error;
        nameInput.value = '';
        showToast(`"${medName}" added to your pharmacy's catalog!`);
        await refreshAllAdminData();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

function renderCatalogTable() {
    const tbody = document.getElementById('catalog-stock-tbody');
    tbody.innerHTML = '';

    const allMedNames = new Set(medicineCatalog.map((m) => m.name));
    grnBatches.forEach((b) => allMedNames.add(b.medicine_name));

    const namesArray = Array.from(allMedNames).sort();
    if (namesArray.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:#64748b;">No medicines registered in catalog yet.</td></tr>`;
        return;
    }

    namesArray.forEach((medName) => {
        const matchingBatches = grnBatches.filter((b) => (b.medicine_name || '').toLowerCase() === medName.toLowerCase() && b.current_quantity > 0);
        const totalQty = matchingBatches.reduce((sum, b) => sum + Number(b.current_quantity || 0), 0);
        const avgPrice = matchingBatches.length > 0 ? matchingBatches.reduce((sum, b) => sum + Number(b.selling_price || 0), 0) / matchingBatches.length : 0;

        let statusBadge = totalQty > 50 ? '<span class="badge badge-success">Healthy Stock</span>' : 
                          totalQty > 0 ? '<span class="badge badge-warning">Low Stock</span>' : 
                          '<span class="badge badge-danger">Out of Stock</span>';

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><strong>${escapeHtml(medName)}</strong></td>
            <td>${matchingBatches.length} Batches</td>
            <td><strong>${totalQty}</strong> Units</td>
            <td>LKR ${formatCurrency(avgPrice)}</td>
            <td>${statusBadge}</td>
        `;
        tbody.appendChild(tr);
    });
}

// ==================== UI NAVIGATION & HELPERS ====================
function switchAdminTab(tabId, btnEl) {
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    document.querySelectorAll('.sidebar-nav .nav-item').forEach((b) => b.classList.remove('active'));

    document.getElementById(`tab-${tabId}`).classList.add('active');
    btnEl.classList.add('active');
}

function logoutAdmin() {
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