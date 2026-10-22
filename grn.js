/* ============================================================================
   PHARMACONNECT - GRN INVENTORY, 2D BULK BARCODE & EXPIRY QUARANTINE CONTROLLER
   ============================================================================ */

const SUPABASE_URL = 'https://juobkaftyrzlxbviudpy.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_qdME8AYk9rz5B4FHs4Eb1g_0vvhN73v';

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const PHARMACY_THEMES = [
    { primary: '#0d9488', secondary: '#0284c7', soft: '#ccfbf1', sidebar: '#0f172a' },
    { primary: '#4f46e5', secondary: '#7c3aed', soft: '#e0e7ff', sidebar: '#1e1b4b' },
    { primary: '#e11d48', secondary: '#ea580c', soft: '#ffe4e6', sidebar: '#270915' },
    { primary: '#d97706', secondary: '#059669', soft: '#fef3c7', sidebar: '#1c1917' }
];

let currentPharmacy = null;
let grnBatches = [];
let medicineCatalog = [];
let decodedBulkItems = [];
let html5QrScanner = null;

// ==================== INITIALIZATION & TENANT GUARD ====================
document.addEventListener('DOMContentLoaded', async () => {
    const params = new URLSearchParams(window.location.search);
    const pharmacyId = params.get('pharmacy_id');
    const savedSession = JSON.parse(sessionStorage.getItem('pc_active_session') || 'null');

    if (!pharmacyId || !savedSession || String(savedSession.pharmacy_id) !== String(pharmacyId)) {
        alert('Unauthorized access! Please sign in with valid credentials for this pharmacy.');
        window.location.href = 'index.html';
        return;
    }

    document.getElementById('session-staff-name').textContent = savedSession.staff_name || 'GRN Officer';
    document.getElementById('session-desk-name').textContent = savedSession.counter_name || 'Stock Intake Desk';

    await loadPharmacyBranding(pharmacyId);
    generateNextGrnNumber();
    document.getElementById('manual-grn-form').addEventListener('submit', handleManualGrnSubmit);

    await refreshGrnData();
});

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
    document.title = `${data.pharmacy_name} | GRN Inventory System`;
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

function generateNextGrnNumber() {
    const randomNum = Math.floor(1000 + Math.random() * 9000);
    // Even if optional, pre-filling helps
    document.getElementById('m-grn-no').value = `GRN-2026-${randomNum}`;
}

// ==================== FETCH GRN STOCK & `medicines` CATALOG ====================
async function refreshGrnData() {
    if (!currentPharmacy) return;

    const [stockRes, medRes] = await Promise.all([
        supabaseClient.from('grn_stock').select('*').eq('pharmacy_id', currentPharmacy.id).order('expiry_date', { ascending: true }),
        supabaseClient.from('medicines').select('*').eq('pharmacy_id', currentPharmacy.id).order('name', { ascending: true })
    ]);

    grnBatches = stockRes.data || [];
    medicineCatalog = medRes.data || [];

    populateMedicineDatalist();
    updateGrnKpisAndAlerts();
    renderGrnInventoryTable();
    renderExpiredQueueTable();
}

function populateMedicineDatalist() {
    const datalist = document.getElementById('pharmacy-medicines-datalist');
    datalist.innerHTML = '';
    medicineCatalog.forEach((med) => {
        const opt = document.createElement('option');
        opt.value = med.name;
        datalist.appendChild(opt);
    });
}

async function ensureMedicineInCatalog(medicineName) {
    const cleanName = medicineName.trim();
    const existing = medicineCatalog.find((m) => (m.name || '').toLowerCase() === cleanName.toLowerCase());
    if (existing) return existing.id;

    const { data, error } = await supabaseClient
        .from('medicines')
        .insert([{ name: cleanName, pharmacy_id: currentPharmacy.id }])
        .select()
        .single();

    if (!error && data) {
        medicineCatalog.push(data);
        return data.id;
    }
    return null;
}

// ==================== KPI & EXPIRED MEDICINE REMINDER SYSTEM ====================
function updateGrnKpisAndAlerts() {
    const todayStr = new Date().toISOString().split('T')[0];
    const nearDate = new Date();
    nearDate.setDate(nearDate.getDate() + 30);
    const nearDateStr = nearDate.toISOString().split('T')[0];

    const activeBatches = grnBatches.filter((b) => b.current_quantity > 0);
    const expiredBatches = activeBatches.filter((b) => b.expiry_date <= todayStr);
    const nearExpiryBatches = activeBatches.filter((b) => b.expiry_date > todayStr && b.expiry_date <= nearDateStr);

    const totalUnits = activeBatches.reduce((sum, b) => sum + Number(b.current_quantity || 0), 0);
    const totalSpend = grnBatches.reduce((sum, b) => sum + (Number(b.quantity_received || 0) * Number(b.unit_cost || 0)), 0);

    document.getElementById('grn-kpi-batches').textContent = activeBatches.length;
    document.getElementById('grn-kpi-catalog-count').textContent = `${medicineCatalog.length} medicines in catalog`;
    document.getElementById('grn-kpi-units').textContent = totalUnits.toLocaleString();
    document.getElementById('grn-kpi-cost').textContent = `LKR ${formatCurrency(totalSpend)}`;
    document.getElementById('grn-kpi-expired').textContent = `${expiredBatches.length} Expired`;
    document.getElementById('grn-kpi-near-expiry').textContent = `${nearExpiryBatches.length} expiring within 30 days`;

    const banner = document.getElementById('urgent-expired-banner');
    const sidebarBadge = document.getElementById('sidebar-expired-badge');

    if (expiredBatches.length > 0) {
        banner.classList.remove('hidden');
        sidebarBadge.classList.remove('hidden');
        sidebarBadge.textContent = expiredBatches.length;
        document.getElementById('expired-banner-title').textContent =
            `Alert: ${expiredBatches.length} Expired Medicine ${expiredBatches.length === 1 ? 'Batch' : 'Batches'} Must Be Removed!`;
    } else {
        banner.classList.add('hidden');
        sidebarBadge.classList.add('hidden');
    }
}

// ==================== RENDER LIVE INVENTORY TABLE ====================
function renderGrnInventoryTable() {
    const tbody = document.getElementById('grn-inventory-tbody');
    const query = (document.getElementById('grn-search-input').value || '').toLowerCase().trim();
    tbody.innerHTML = '';

    const todayStr = new Date().toISOString().split('T')[0];
    const nearDate = new Date();
    nearDate.setDate(nearDate.getDate() + 30);
    const nearDateStr = nearDate.toISOString().split('T')[0];

    const filtered = grnBatches.filter((b) => {
        return (
            (b.medicine_name || '').toLowerCase().includes(query) ||
            (b.batch_number || '').toLowerCase().includes(query) ||
            (b.grn_number || '').toLowerCase().includes(query) ||
            (b.rack_location || '').toLowerCase().includes(query)
        );
    });

    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; color:#64748b;">No stock batches found. Add stock via Manual Entry or 2D Barcode Bulk Intake.</td></tr>`;
        return;
    }

    filtered.forEach((b) => {
        let statusHtml = '<span class="badge badge-success">Healthy</span>';
        if (b.expiry_date <= todayStr) {
            statusHtml = '<span class="badge badge-danger"><i class="fa-solid fa-skull-crossbones"></i> EXPIRED</span>';
        } else if (b.expiry_date <= nearDateStr) {
            statusHtml = '<span class="badge badge-warning">Expiring Soon</span>';
        } else if (b.current_quantity <= 20) {
            statusHtml = '<span class="badge badge-info">Low Stock</span>';
        }

        // Handle null values gracefully for display
        const displayGrn = b.grn_number ? escapeHtml(b.grn_number) : '-';
        const displayBatch = b.batch_number ? escapeHtml(b.batch_number) : 'N/A';
        const displaySupplier = b.supplier_name ? escapeHtml(b.supplier_name) : '-';
        const displayRack = b.rack_location ? escapeHtml(b.rack_location) : 'Unassigned';

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><strong>${displayGrn}</strong><br><small style="color:#64748b;">Batch: ${displayBatch}</small></td>
            <td><strong>${escapeHtml(b.medicine_name)}</strong></td>
            <td>${escapeHtml(b.category)}<br><small style="color:#0d9488; font-weight:700;">${displayRack}</small></td>
            <td>${displaySupplier}</td>
            <td><strong>${b.current_quantity}</strong> / ${b.quantity_received}</td>
            <td>Cost: LKR ${formatCurrency(b.unit_cost)}<br><strong>MRP: LKR ${formatCurrency(b.selling_price)}</strong></td>
            <td><strong>${escapeHtml(b.expiry_date)}</strong></td>
            <td>${statusHtml}</td>
            <td>
                <button class="btn btn-outline" style="padding: 6px 10px; color: var(--danger); border-color: var(--danger);" title="Delete Batch" onclick="deleteGrnBatch('${b.id}')">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

// Function to handle database deletion of a specific GRN batch row
async function deleteGrnBatch(batchId) {
    if (!confirm('Are you sure you want to delete this batch from the database? This action cannot be undone.')) {
        return;
    }
    
    try {
        const { error } = await supabaseClient
            .from('grn_stock')
            .delete()
            .eq('id', batchId)
            .eq('pharmacy_id', currentPharmacy.id);
            
        if (error) throw error;
        
        showToast('Batch successfully deleted from database.');
        await refreshGrnData();
    } catch (err) {
        showToast(err.message, 'error');
    }
}


// ==================== METHOD 1: MANUAL GRN ENTRY (True Optional Fields) ====================
async function handleManualGrnSubmit(e) {
    e.preventDefault();
    if (!currentPharmacy) return;

    // Required fields
    const medName = document.getElementById('m-medicine-name').value.trim();
    const category = document.getElementById('m-category').value;
    const qty = parseInt(document.getElementById('m-qty').value, 10);
    const unitCost = parseFloat(document.getElementById('m-cost').value);
    const sellingPrice = parseFloat(document.getElementById('m-price').value);
    const expDate = document.getElementById('m-exp-date').value;

    // Optional fields (Sends NULL if left empty)
    const supplier = document.getElementById('m-supplier').value.trim() || null;
    const grnNo = document.getElementById('m-grn-no').value.trim() || null;
    const batchNo = document.getElementById('m-batch-no').value.trim() || null;
    const rack = document.getElementById('m-rack').value.trim() || null;
    const mfgDate = document.getElementById('m-mfg-date').value || null;

    const btn = document.getElementById('btn-submit-manual-grn');
    btn.disabled = true;

    try {
        const medicineId = await ensureMedicineInCatalog(medName);

        const { error } = await supabaseClient.from('grn_stock').insert([{
            pharmacy_id: currentPharmacy.id,
            medicine_id: medicineId,
            medicine_name: medName,
            grn_number: grnNo,
            batch_number: batchNo,
            supplier_name: supplier,
            category: category,
            quantity_received: qty,
            current_quantity: qty,
            unit_cost: unitCost,
            selling_price: sellingPrice,
            manufacture_date: mfgDate,
            expiry_date: expDate,
            rack_location: rack
        }]);

        if (error) throw error;

        document.getElementById('manual-grn-form').reset();
        
        // Remove the auto-generation function call since GRN is now optional
        document.getElementById('m-grn-no').value = ''; 

        showToast(`Batch added successfully!`);
        await refreshGrnData();
        switchGrnTab('inventory', document.querySelectorAll('.sidebar-nav .nav-item')[0]);
    } catch (err) {
        showToast(err.message || 'Failed to save GRN batch.', 'error');
    } finally {
        btn.disabled = false;
    }
}
// ==================== METHOD 2: 2D BARCODE BULK MANIFEST SCANNER ====================
function start2DCameraScanner() {
    if (html5QrScanner) return;
    html5QrScanner = new Html5Qrcode('qr-reader');

    html5QrScanner.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 250, height: 250 } },
        (decodedText) => {
            document.getElementById('raw-2d-payload').value = decodedText;
            showToast('2D Manifest Barcode Scanned!');
            stop2DCameraScanner();
            parse2DBarcodePayload();
        },
        () => {}
    ).catch((err) => {
        showToast(`Camera access error: ${err}`, 'error');
        html5QrScanner = null;
    });
}

function stop2DCameraScanner() {
    if (!html5QrScanner) return;
    html5QrScanner.stop().then(() => {
        html5QrScanner.clear();
        html5QrScanner = null;
    });
}

function generateSample2DManifest() {
    const sampleShipmentManifest = {
        grn: `GRN-2D-${Math.floor(1000 + Math.random() * 9000)}`,
        supplier: 'State Pharmaceuticals Corp (SPC)',
        items: [
            { n: 'Paracetamol BP 500mg', b: 'BTH-901A', c: 'Tablet', q: 1000, uc: 7.5, sp: 14.0, exp: '2027-11-15', r: 'Rack A-01' },
            { n: 'Amoxicillin 250mg Caps', b: 'BTH-902B', c: 'Capsule', q: 500, uc: 22.0, sp: 38.0, exp: '2027-08-20', r: 'Rack A-02' },
            { n: 'Azithromycin 500mg Tab', b: 'BTH-903C', c: 'Tablet', q: 300, uc: 85.0, sp: 135.0, exp: '2028-01-10', r: 'Rack B-01' },
            { n: 'Salbutamol Inhaler 100mcg', b: 'BTH-904D', c: 'Inhaler', q: 120, uc: 480.0, sp: 690.0, exp: '2027-06-30', r: 'Rack C-04' },
            { n: 'Omeprazole 20mg Gastro', b: 'BTH-905E', c: 'Capsule', q: 800, uc: 14.0, sp: 25.0, exp: '2027-09-12', r: 'Rack A-05' },
            { n: 'Cough Syrup Diphenhydramine (EXPIRED SAMPLE)', b: 'EXP-404X', c: 'Syrup', q: 45, uc: 210.0, sp: 340.0, exp: '2025-12-01', r: 'Rack D-09' }
        ]
    };

    const payloadString = JSON.stringify(sampleShipmentManifest);
    document.getElementById('raw-2d-payload').value = payloadString;

    const qrContainer = document.getElementById('generated-qr-container');
    qrContainer.innerHTML = '';
    new QRCode(qrContainer, {
        text: payloadString,
        width: 190,
        height: 190,
        correctLevel: QRCode.CorrectLevel.L
    });

    parse2DBarcodePayload();
    showToast('Generated 2D Shipment Barcode & decoded 6 medicine batches!');
}

function parse2DBarcodePayload() {
    const raw = document.getElementById('raw-2d-payload').value.trim();
    if (!raw) {
        showToast('Please scan a 2D barcode or generate a sample manifest first.', 'error');
        return;
    }

    try {
        const parsed = JSON.parse(raw);
        const items = parsed.items || (Array.isArray(parsed) ? parsed : []);
        if (items.length === 0) throw new Error('No batch items found in 2D barcode payload.');

        decodedBulkItems = items.map((item) => ({
            grn_number: parsed.grn || `GRN-2D-${Date.now().toString().slice(-4)}`,
            supplier_name: parsed.supplier || item.supplier || 'Wholesale Distributor',
            medicine_name: item.n || item.medicine_name,
            batch_number: item.b || item.batch_number,
            category: item.c || item.category || 'Tablet',
            quantity_received: Number(item.q || item.quantity || 100),
            unit_cost: Number(item.uc || item.unit_cost || 10),
            selling_price: Number(item.sp || item.selling_price || 15),
            expiry_date: item.exp || item.expiry_date || '2027-12-31',
            rack_location: item.r || item.rack_location || 'Main Shelf'
        }));

        renderManifestPreview();
    } catch (err) {
        showToast('Invalid 2D Barcode JSON structure. Click "Generate Sample 2D Shipment Barcode" to test.', 'error');
    }
}

function renderManifestPreview() {
    const card = document.getElementById('decoded-manifest-card');
    const tbody = document.getElementById('manifest-preview-tbody');
    document.getElementById('manifest-item-count').textContent = decodedBulkItems.length;

    tbody.innerHTML = '';
    decodedBulkItems.forEach((item) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><strong>${escapeHtml(item.medicine_name)}</strong></td>
            <td><code>${escapeHtml(item.batch_number)}</code></td>
            <td>${escapeHtml(item.category)}</td>
            <td>${escapeHtml(item.supplier_name)}</td>
            <td><strong>${item.quantity_received}</strong></td>
            <td>LKR ${formatCurrency(item.unit_cost)}</td>
            <td>LKR ${formatCurrency(item.selling_price)}</td>
            <td>${escapeHtml(item.expiry_date)}</td>
            <td>${escapeHtml(item.rack_location)}</td>
        `;
        tbody.appendChild(tr);
    });

    card.classList.remove('hidden');
}

async function commitBulkManifestToSupabase() {
    if (!currentPharmacy || decodedBulkItems.length === 0) return;

    const btn = document.getElementById('btn-commit-bulk');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Importing Entire Shipment...';

    try {
        const rowsToInsert = [];
        for (const item of decodedBulkItems) {
            const medId = await ensureMedicineInCatalog(item.medicine_name);
            rowsToInsert.push({
                pharmacy_id: currentPharmacy.id,
                medicine_id: medId,
                medicine_name: item.medicine_name,
                grn_number: item.grn_number,
                batch_number: item.batch_number,
                supplier_name: item.supplier_name,
                category: item.category,
                quantity_received: item.quantity_received,
                current_quantity: item.quantity_received,
                unit_cost: item.unit_cost,
                selling_price: item.selling_price,
                expiry_date: item.expiry_date,
                rack_location: item.rack_location
            });
        }

        const { error } = await supabaseClient.from('grn_stock').insert(rowsToInsert);
        if (error) throw error;

        decodedBulkItems = [];
        document.getElementById('decoded-manifest-card').classList.add('hidden');
        document.getElementById('raw-2d-payload').value = '';

        showToast(`Successfully imported ${rowsToInsert.length} batches via 2D Barcode!`);
        await refreshGrnData();
        switchGrnTab('inventory', document.querySelectorAll('.sidebar-nav .nav-item')[0]);
    } catch (err) {
        showToast(err.message || 'Bulk import failed.', 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-check-double"></i> Confirm & Import Entire Stock to Supabase';
    }
}

// ==================== EXPIRED STOCK QUARANTINE & "DONE" REMOVAL ====================
function renderExpiredQueueTable() {
    const tbody = document.getElementById('expired-queue-tbody');
    tbody.innerHTML = '';

    const todayStr = new Date().toISOString().split('T')[0];
    const expiredList = grnBatches.filter((b) => b.expiry_date <= todayStr && b.current_quantity > 0);

    if (expiredList.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:#15803d; font-weight:700;"><i class="fa-solid fa-circle-check"></i> All clear! Zero expired medicines in active stock.</td></tr>`;
        return;
    }

    expiredList.forEach((b) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><strong style="color:#b91c1c;">${escapeHtml(b.medicine_name)}</strong></td>
            <td>Batch: <code>${escapeHtml(b.batch_number)}</code><br><small>${escapeHtml(b.grn_number)}</small></td>
            <td><span class="badge badge-warning"><i class="fa-solid fa-location-dot"></i> ${escapeHtml(b.rack_location)}</span></td>
            <td><strong>${b.current_quantity} Units</strong></td>
            <td><span class="badge badge-danger">Expired: ${escapeHtml(b.expiry_date)}</span></td>
            <td>
                <button class="btn btn-danger-done" onclick="markExpiredBatchDone('${b.id}', '${escapeHtml(b.medicine_name)}')">
                    <i class="fa-solid fa-check"></i> Done (Remove from Stock)
                </button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

async function markExpiredBatchDone(batchId, medName) {
    const { error } = await supabaseClient
        .from('grn_stock')
        .delete()
        .eq('id', batchId)
        .eq('pharmacy_id', currentPharmacy.id);

    if (error) {
        showToast(error.message, 'error');
        return;
    }

    showToast(`Removed expired "${medName}" from stock & cleared reminder!`);
    await refreshGrnData();
}

async function removeAllExpiredStock() {
    const todayStr = new Date().toISOString().split('T')[0];
    const expiredIds = grnBatches
        .filter((b) => b.expiry_date <= todayStr)
        .map((b) => b.id);

    if (expiredIds.length === 0) {
        showToast('No expired batches to remove.');
        return;
    }

    const { error } = await supabaseClient
        .from('grn_stock')
        .delete()
        .in('id', expiredIds);

    if (error) {
        showToast(error.message, 'error');
        return;
    }

    showToast(`Purged all ${expiredIds.length} expired batches from inventory!`);
    await refreshGrnData();
}

// ==================== UI HELPERS ====================
function switchGrnTab(tabId, btnEl) {
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    document.querySelectorAll('.sidebar-nav .nav-item').forEach((b) => b.classList.remove('active'));

    document.getElementById(`tab-${tabId}`).classList.add('active');
    if (btnEl) btnEl.classList.add('active');
}

function logoutGrn() {
    stop2DCameraScanner();
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