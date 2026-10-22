/* ============================================================================
   PHARMACONNECT - DYNAMIC MULTI-TENANT ADMIN CONTROLLER
   ============================================================================ */

const SUPABASE_URL = 'https://juobkaftyrzlxbviudpy.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_qdME8AYk9rz5B4FHs4Eb1g_0vvhN73v';

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

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

let cashflowChartInstance = null;
let topMedicinesChartInstance = null;

// ==================== INITIALIZATION & TENANT SECURITY CHECK ====================
document.addEventListener('DOMContentLoaded', async () => {
    const params = new URLSearchParams(window.location.search);
    const pharmacyId = params.get('pharmacy_id');
    const savedSession = JSON.parse(sessionStorage.getItem('pc_active_session') || 'null');

    if (!pharmacyId || !savedSession || String(savedSession.pharmacy_id) !== String(pharmacyId)) {
        alert('Unauthorized access! Please sign in through your specific pharmacy tile first.');
        window.location.href = 'index.html';
        return;
    }

    await loadTenantPharmacyDetails(pharmacyId);
    setupAdminListeners();
    await refreshAllAdminData();
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

    // Populate Dynamic Pharmacy Branding
    document.title = `${data.pharmacy_name} | Admin Console`;
    document.getElementById('sidebar-pharmacy-name').textContent = data.pharmacy_name;
    document.getElementById('sidebar-pharmacy-license').textContent = data.license_no;
    document.getElementById('sidebar-pharmacy-city').textContent = `${data.address}, ${data.city}`;
    document.getElementById('session-admin-name').textContent = data.admin_username;
    document.getElementById('sidebar-banner').style.backgroundImage = `url('${data.image_url || ''}')`;
    document.getElementById('link-open-grn').href = `grn.html?pharmacy_id=${encodeURIComponent(data.id)}`;

    // Pick a deterministic dynamic theme based on pharmacy ID (or saved preference)
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
}

// ==================== LOAD ALL PHARMACY-ISOLATED DATA ====================
async function refreshAllAdminData() {
    if (!currentPharmacy) return;

    const [staffRes, grnRes, salesRes, medRes] = await Promise.all([
        supabaseClient.from('pharmacy_staff').select('*').eq('pharmacy_id', currentPharmacy.id).order('created_at', { ascending: false }),
        supabaseClient.from('grn_stock').select('*').eq('pharmacy_id', currentPharmacy.id).order('created_at', { ascending: false }),
        supabaseClient.from('sales_transactions').select('*').eq('pharmacy_id', currentPharmacy.id).order('sold_at', { ascending: false }),
        supabaseClient.from('medicines').select('*').eq('pharmacy_id', currentPharmacy.id).order('name', { ascending: true })
    ]);

    staffRecords = staffRes.data || [];
    grnBatches = grnRes.data || [];
    salesRecords = salesRes.data || [];
    medicineCatalog = medRes.data || [];

    populateCounterFilterDropdown();
    renderDashboardAnalytics();
    renderStaffTable();
    renderCatalogTable();
}

// ==================== COUNTER FILTER & DASHBOARD CHARTS ====================
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

    select.innerHTML = '<option value="ALL">All Counters (Combined Pharmacy Sales)</option>';
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

    const filteredSales = selectedCounter === 'ALL'
        ? salesRecords
        : salesRecords.filter((s) => s.counter_name === selectedCounter);

    document.getElementById('counter-sales-summary-badge').textContent =
        `${filteredSales.length} Sales Transactions (${selectedCounter === 'ALL' ? 'All Counters' : selectedCounter})`;

    // Calculate KPIs
    const totalSalesRevenue = filteredSales.reduce((acc, s) => acc + Number(s.total_amount || 0), 0);
    const totalSalesProfit = filteredSales.reduce((acc, s) => acc + Number(s.profit_amount || 0), 0);
    const totalGrnExpenses = grnBatches.reduce((acc, b) => acc + (Number(b.quantity_received || 0) * Number(b.unit_cost || 0)), 0);
    const activeStockValuation = grnBatches.reduce((acc, b) => acc + (Number(b.current_quantity || 0) * Number(b.selling_price || 0)), 0);

    const todayStr = new Date().toISOString().split('T')[0];
    const expiredCount = grnBatches.filter((b) => b.expiry_date <= todayStr && b.current_quantity > 0).length;

    const profitMargin = totalSalesRevenue > 0 ? ((totalSalesProfit / totalSalesRevenue) * 100).toFixed(1) : '0.0';

    document.getElementById('kpi-cash-inflow').textContent = `LKR ${formatCurrency(totalSalesRevenue)}`;
    document.getElementById('kpi-sales-count').textContent = `Across ${filteredSales.length} counter bills`;
    document.getElementById('kpi-grn-expenses').textContent = `LKR ${formatCurrency(totalGrnExpenses)}`;
    document.getElementById('kpi-grn-batches').textContent = `${grnBatches.length} GRN batches recorded`;
    document.getElementById('kpi-net-profit').textContent = `LKR ${formatCurrency(totalSalesProfit)}`;
    document.getElementById('kpi-profit-margin').textContent = `Gross Margin: ${profitMargin}%`;
    document.getElementById('kpi-stock-value').textContent = `LKR ${formatCurrency(activeStockValuation)}`;
    document.getElementById('kpi-expired-warning').textContent = `${expiredCount} expired batches requiring removal`;

    renderCharts(filteredSales, totalGrnExpenses);
    renderCounterBreakdownTable();
}

function renderCharts(filteredSales, totalGrnExpenses) {
    const primaryColor = getComputedStyle(document.documentElement).getPropertyValue('--brand-primary').trim() || '#0d9488';
    const secondaryColor = getComputedStyle(document.documentElement).getPropertyValue('--brand-secondary').trim() || '#0284c7';

    // 1. Cash Flow, Expenses & Profit Grouped Chart (Last 6 Days / Categories)
    const dayLabels = [];
    const revenueSeries = [];
    const profitSeries = [];
    const expenseSeries = [];

    for (let i = 5; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const dateKey = d.toISOString().split('T')[0];
        const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        dayLabels.push(label);

        const daySales = filteredSales.filter((s) => (s.sold_at || '').startsWith(dateKey));
        const dayGrn = grnBatches.filter((b) => (b.created_at || '').startsWith(dateKey));

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
                {
                    label: 'Cash Inflow (Sales LKR)',
                    data: revenueSeries,
                    backgroundColor: primaryColor,
                    borderRadius: 6
                },
                {
                    label: 'GRN Stock Expenses (LKR)',
                    data: expenseSeries,
                    backgroundColor: '#ef4444',
                    borderRadius: 6
                },
                {
                    label: 'Gross Profit (LKR)',
                    data: profitSeries,
                    backgroundColor: '#10b981',
                    borderRadius: 6
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { position: 'top' }
            },
            scales: {
                y: { beginAtZero: true }
            }
        }
    });

    // 2. Most Sold Medicines Horizontal Bar Chart
    const medTotals = {};
    filteredSales.forEach((sale) => {
        const name = sale.medicine_name || 'Unknown';
        medTotals[name] = (medTotals[name] || 0) + Number(sale.quantity_sold || 0);
    });

    const sortedMeds = Object.entries(medTotals)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6);

    const medLabels = sortedMeds.length > 0 ? sortedMeds.map((i) => i[0]) : ['No Sales Yet'];
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
            plugins: {
                legend: { display: false }
            },
            scales: {
                x: { beginAtZero: true }
            }
        }
    });
}

function renderCounterBreakdownTable() {
    const tbody = document.getElementById('counter-performance-tbody');
    tbody.innerHTML = '';

    const counterMap = {};

    // Pre-populate registered cashier counters
    staffRecords.filter((s) => s.role === 'cashier').forEach((s) => {
        const key = s.counter_name || 'Unassigned Counter';
        counterMap[key] = {
            counter_name: key,
            cashier_username: s.username,
            bills: 0,
            units: 0,
            revenue: 0,
            profit: 0
        };
    });

    // Aggregate actual sales
    salesRecords.forEach((s) => {
        const key = s.counter_name || 'Main Counter';
        if (!counterMap[key]) {
            counterMap[key] = {
                counter_name: key,
                cashier_username: s.cashier_username || 'cashier',
                bills: 0,
                units: 0,
                revenue: 0,
                profit: 0
            };
        }
        counterMap[key].bills += 1;
        counterMap[key].units += Number(s.quantity_sold || 0);
        counterMap[key].revenue += Number(s.total_amount || 0);
        counterMap[key].profit += Number(s.profit_amount || 0);
    });

    const rows = Object.values(counterMap);
    if (rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:#64748b;">No counters or sales recorded yet. Register a Cashier in "Staff & Counter Logins" or click "Simulate Counter Sales".</td></tr>`;
        return;
    }

    rows.forEach((row) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><strong>${escapeHtml(row.counter_name)}</strong></td>
            <td><code>${escapeHtml(row.cashier_username)}</code></td>
            <td><span class="badge badge-info">${row.bills} Sales</span></td>
            <td>${row.units} Units</td>
            <td><strong>LKR ${formatCurrency(row.revenue)}</strong></td>
            <td><span class="badge badge-success">+ LKR ${formatCurrency(row.profit)}</span></td>
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
    const password = document.getElementById('staff-password').value.trim();

    const btn = document.getElementById('btn-save-staff');
    btn.disabled = true;

    try {
        const { error } = await supabaseClient
            .from('pharmacy_staff')
            .insert([{
                pharmacy_id: currentPharmacy.id,
                full_name: fullName,
                role: role,
                counter_name: counterName,
                username: username,
                password: password,
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
            <td><code>${escapeHtml(staff.password)}</code></td>
            <td><span class="badge badge-success">Active</span></td>
            <td>
                <button class="btn btn-danger-done" onclick="deleteStaffAccount('${staff.id}')">
                    <i class="fa-solid fa-trash"></i> Remove
                </button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

async function deleteStaffAccount(staffId) {
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
            .insert([{
                name: medName,
                pharmacy_id: currentPharmacy.id
            }]);

        if (error) throw error;
        nameInput.value = '';
        showToast(`"${medName}" added to your pharmacy's medicines table!`);
        await refreshAllAdminData();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

function renderCatalogTable() {
    const tbody = document.getElementById('catalog-stock-tbody');
    tbody.innerHTML = '';

    // Combine medicine names from `medicines` table and `grn_stock`
    const allMedNames = new Set(medicineCatalog.map((m) => m.name));
    grnBatches.forEach((b) => allMedNames.add(b.medicine_name));

    const namesArray = Array.from(allMedNames).sort();
    if (namesArray.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:#64748b;">No medicines registered in catalog yet. Add medicines above or via the GRN Portal.</td></tr>`;
        return;
    }

    namesArray.forEach((medName) => {
        const matchingBatches = grnBatches.filter(
            (b) => (b.medicine_name || '').toLowerCase() === medName.toLowerCase() && b.current_quantity > 0
        );
        const totalQty = matchingBatches.reduce((sum, b) => sum + Number(b.current_quantity || 0), 0);
        const avgPrice = matchingBatches.length > 0
            ? matchingBatches.reduce((sum, b) => sum + Number(b.selling_price || 0), 0) / matchingBatches.length
            : 0;

        let statusBadge = '<span class="badge badge-danger">Out of Stock</span>';
        if (totalQty > 50) statusBadge = '<span class="badge badge-success">Healthy Stock</span>';
        else if (totalQty > 0) statusBadge = '<span class="badge badge-warning">Low Stock</span>';

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

// ==================== SIMULATE COUNTER SALES FOR TESTING CHARTS ====================
async function seedSampleCounterSales() {
    if (!currentPharmacy) return;

    const sampleMeds = [
        { name: 'Panadol Paracetamol 500mg', cost: 8, price: 14 },
        { name: 'Amoxicillin 500mg Capsules', cost: 28, price: 45 },
        { name: 'Augmentin 625mg Duo Tab', cost: 140, price: 210 },
        { name: 'Cetirizine 10mg Antihistamine', cost: 6, price: 12 },
        { name: 'Losartan Potassium 50mg', cost: 18, price: 32 },
        { name: 'Metformin HCl 500mg Sustained', cost: 11, price: 20 }
    ];

    const counters = [
        { counter: 'Counter 01', user: 'cashier_01' },
        { counter: 'Counter 02', user: 'cashier_02' },
        { counter: 'Counter 03 (Express)', user: 'cashier_03' }
    ];

    const rowsToInsert = [];
    for (let i = 0; i < 12; i++) {
        const med = sampleMeds[Math.floor(Math.random() * sampleMeds.length)];
        const c = counters[Math.floor(Math.random() * counters.length)];
        const qty = Math.floor(Math.random() * 25) + 5;
        const daysAgo = Math.floor(Math.random() * 5);
        const saleDate = new Date();
        saleDate.setDate(saleDate.getDate() - daysAgo);

        const total = qty * med.price;
        const profit = qty * (med.price - med.cost);

        rowsToInsert.push({
            pharmacy_id: currentPharmacy.id,
            invoice_no: `INV-${Math.floor(10000 + Math.random() * 90000)}`,
            counter_name: c.counter,
            cashier_username: c.user,
            medicine_name: med.name,
            quantity_sold: qty,
            unit_cost: med.cost,
            unit_price: med.price,
            total_amount: total,
            profit_amount: profit,
            sold_at: saleDate.toISOString()
        });
    }

    const { error } = await supabaseClient.from('sales_transactions').insert(rowsToInsert);
    if (error) {
        showToast(error.message, 'error');
        return;
    }

    showToast('12 Counter Sales simulated! Use the Counter Filter dropdown to test.');
    await refreshAllAdminData();
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