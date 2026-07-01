const $ = (id) => document.getElementById(id);

const state = {
  config: null,
  statusTimer: null,
  transactionTimer: null,
  transactionStartedAt: 0,
  paymentLock: false
};

function toast(message, type = 'ok') {
  const el = $('toast');
  el.textContent = message;
  el.className = `toast show ${type}`;
  setTimeout(() => { el.className = 'toast'; }, 3500);
}

async function request(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `Chyba ${res.status}`);
  }
  return data;
}

function setPaymentState(text, variant = '') {
  const el = $('paymentState');
  el.textContent = text;
  el.className = `soft-pill ${variant}`;
}

function readerId() {
  return localStorage.getItem('sumupReaderId') || state.config?.savedReaderId || state.config?.envReaderId || '';
}

function setReaderId(id) {
  const value = id || '';
  if (value) localStorage.setItem('sumupReaderId', value);
  $('readerText').textContent = value || '–';
  $('cfgReader').textContent = value || '–';
  $('readerMini').textContent = `Reader: ${value ? value.slice(0, 18) + '…' : '–'}`;
}

function formatDate(value) {
  if (!value) return '–';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString('cs-CZ', { dateStyle: 'short', timeStyle: 'short' });
}

function formatAmount(tx) {
  const amount = typeof tx.amount === 'number' ? tx.amount : Number(tx.amount || 0);
  const currency = tx.currency || 'CZK';
  return `${amount.toLocaleString('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

function statusClass(status) {
  const s = String(status || '').toUpperCase();
  if (['SUCCESSFUL', 'PAID_OUT'].includes(s)) return 'status-ok';
  if (['FAILED', 'CANCELLED', 'REFUNDED', 'CHARGEBACK'].includes(s)) return 'status-bad';
  return 'status-pending';
}

function addLocalPayment(item) {
  const list = JSON.parse(localStorage.getItem('localPayments') || '[]');
  list.unshift(item);
  localStorage.setItem('localPayments', JSON.stringify(list.slice(0, 20)));
}

function loadLocalPayments() {
  return JSON.parse(localStorage.getItem('localPayments') || '[]');
}

async function loadConfig() {
  const cfg = await request('/api/config');
  state.config = cfg;
  $('modeText').textContent = cfg.mode;
  $('modePill').textContent = cfg.mode === 'sumup' ? 'OSTRÝ SUMUP REŽIM' : 'TESTOVACÍ REŽIM';
  $('modePill').className = `pill ${cfg.mode === 'sumup' ? 'ok' : 'mock'}`;
  $('cfgApi').textContent = cfg.hasApiKey ? 'vyplněno' : 'chybí';
  $('cfgMerchant').textContent = cfg.hasMerchantCode ? cfg.merchantCode : 'chybí';
  $('cfgAffiliate').textContent = cfg.hasAffiliateKey && cfg.hasAffiliateAppId ? 'vyplněno' : 'chybí';
  setReaderId(readerId());

  if (cfg.mode === 'sumup' && (!cfg.hasApiKey || !cfg.hasMerchantCode || !cfg.hasAffiliateKey || !cfg.hasAffiliateAppId)) {
    setPaymentState('Doplňte .env', 'error');
  } else if (!readerId()) {
    setPaymentState('Spárujte terminál', 'waiting');
  } else {
    setPaymentState('Připraveno');
  }
}

async function pollStatus() {
  const rid = readerId();
  if (!rid) return;
  try {
    const data = await request(`/api/status?readerId=${encodeURIComponent(rid)}`);
    $('readerStatus').textContent = data.status || data.data?.status || 'ONLINE';
    const terminalState = data.state || data.data?.state || data.reader_state || '–';
    $('readerState').textContent = terminalState;
    const s = String(terminalState).toUpperCase();
    if (s.includes('WAITING_FOR_CARD')) setPaymentState('Čeká na kartu', 'waiting');
    if (s.includes('WAITING_FOR_PIN')) setPaymentState('Čeká na PIN', 'waiting');
    if (s === 'IDLE' && $('paymentState').textContent.includes('Čeká')) setPaymentState('Připraveno');
  } catch (err) {
    $('readerStatus').textContent = 'Chyba';
    $('readerState').textContent = err.message;
  }
}

async function listReaders() {
  try {
    const data = await request('/api/readers');
    $('readerOutput').textContent = JSON.stringify(data, null, 2);
    if (data.items?.[0]?.id) {
      setReaderId(data.items[0].id);
      toast('Našel jsem reader a uložil ho do prohlížeče.');
      await pollStatus();
    } else {
      toast('Žádný reader nenalezený.', 'error');
    }
  } catch (err) {
    $('readerOutput').textContent = err.message;
    toast(err.message, 'error');
  }
}

async function pairReader() {
  const pairingCode = $('pairingCode').value.trim().toUpperCase();
  const name = $('readerName').value.trim() || 'DE.PO.NA pokladna';
  if (!pairingCode) return toast('Zadejte párovací kód ze SumUp Solo.', 'error');
  try {
    setPaymentState('Páruji…', 'waiting');
    const data = await request('/api/pair', {
      method: 'POST',
      body: JSON.stringify({ pairingCode, name })
    });
    $('readerOutput').textContent = JSON.stringify(data, null, 2);
    if (data.id) setReaderId(data.id);
    $('pairingCode').value = '';
    setPaymentState('Spárováno');
    toast('Terminál spárován. Tenhle kód už znovu nepotřebujete.');
    await pollStatus();
    await loadTransactions();
  } catch (err) {
    setPaymentState('Párování selhalo', 'error');
    toast(err.message, 'error');
  }
}

async function forgetReader() {
  try {
    await request('/api/forget-reader', { method: 'POST', body: JSON.stringify({}) });
    localStorage.removeItem('sumupReaderId');
    setReaderId('');
    $('readerOutput').textContent = 'Reader zapomenutý. Pro další použití ho znovu spárujte.';
    setPaymentState('Spárujte terminál', 'waiting');
    toast('Reader zapomenutý.');
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function sendPayment() {
  if (state.paymentLock) return toast('Platba už je odeslaná. Počkejte na výsledek nebo ji zrušte.', 'error');
  const amountKc = $('amount').value.trim();
  if (!amountKc) return toast('Zadejte částku.', 'error');
  const rid = readerId();
  if (!rid) return toast('Nejdřív spárujte terminál v Nastavení.', 'error');

  try {
    state.paymentLock = true;
    $('sendPayment').disabled = true;
    setPaymentState('Odesílám…', 'waiting');
    const data = await request('/api/pay', {
      method: 'POST',
      body: JSON.stringify({ amountKc, note: $('note').value, readerId: rid })
    });
    const clientId = data.data?.client_transaction_id || data.client_transaction_id || data.checkout?.client_transaction_id || '';
    const item = { amountKc, note: $('note').value, clientId, foreignId: data.foreign_transaction_id || '', createdAt: new Date().toISOString(), status: 'PENDING' };
    addLocalPayment(item);
    localStorage.setItem('lastPayment', JSON.stringify(item));
    $('lastTransaction').textContent = clientId ? `${amountKc} Kč / ${clientId.slice(0, 8)}…` : `${amountKc} Kč / odesláno`;
    setPaymentState('Čeká na zákazníka', 'waiting');
    toast('Platba odeslána na terminál.');
    if (clientId) startTransactionPolling(clientId, amountKc);
    else setTimeout(() => { state.paymentLock = false; $('sendPayment').disabled = false; }, 60000);
  } catch (err) {
    state.paymentLock = false;
    $('sendPayment').disabled = false;
    setPaymentState('Chyba platby', 'error');
    toast(err.message, 'error');
  }
}

function startTransactionPolling(clientId, amountKc) {
  clearInterval(state.transactionTimer);
  state.transactionStartedAt = Date.now();
  state.transactionTimer = setInterval(async () => {
    const elapsed = Math.floor((Date.now() - state.transactionStartedAt) / 1000);
    try {
      const data = await request(`/api/transaction?client_transaction_id=${encodeURIComponent(clientId)}&elapsed=${elapsed}`);
      const status = data.simple_status || data.status || data.transaction?.simple_status || data.transaction?.status || data.data?.simple_status || data.data?.status || 'PENDING';
      $('lastTransaction').textContent = `${clientId.slice(0, 8)}… / ${status}`;
      if (['SUCCESSFUL', 'PAID_OUT'].includes(String(status).toUpperCase())) {
        setPaymentState('Platba schválena');
        addLocalPayment({ amountKc, clientId, createdAt: new Date().toISOString(), status: 'SUCCESSFUL' });
        state.paymentLock = false;
        $('sendPayment').disabled = false;
        clearInterval(state.transactionTimer);
        loadTransactions();
      }
      if (['FAILED', 'CANCELLED', 'CANCEL_FAILED'].includes(String(status).toUpperCase())) {
        setPaymentState('Platba neproběhla', 'error');
        state.paymentLock = false;
        $('sendPayment').disabled = false;
        clearInterval(state.transactionTimer);
        loadTransactions();
      }
      if (elapsed > 150) {
        setPaymentState('Ověřte v SumUp', 'waiting');
        state.paymentLock = false;
        $('sendPayment').disabled = false;
        clearInterval(state.transactionTimer);
      }
    } catch (_) {
      if (elapsed > 150) {
        state.paymentLock = false;
        $('sendPayment').disabled = false;
        clearInterval(state.transactionTimer);
      }
    }
  }, 3000);
}

async function terminatePayment() {
  const rid = readerId();
  if (!rid) return toast('Chybí Reader ID.', 'error');
  try {
    await request('/api/terminate', { method: 'POST', body: JSON.stringify({ readerId: rid }) });
    setPaymentState('Čekající platba zrušena', 'error');
    state.paymentLock = false;
    $('sendPayment').disabled = false;
    toast('Požadavek na zrušení čekající platby odeslán.');
  } catch (err) {
    toast(err.message, 'error');
  }
}

function renderTransactions(items, source = 'SumUp') {
  const body = $('transactionsBody');
  if (!items || !items.length) {
    body.innerHTML = '<tr><td colspan="5" class="empty">Žádné transakce k zobrazení.</td></tr>';
    $('transactionsSummary').textContent = 'Žádné transakce.';
    return;
  }
  $('transactionsSummary').textContent = `${source}: načteno ${items.length} transakcí.`;
  body.innerHTML = items.map(tx => {
    const status = tx.simple_status || tx.status || '–';
    const code = tx.transaction_code || tx.client_transaction_id || tx.id || '–';
    return `<tr>
      <td>${formatDate(tx.timestamp || tx.createdAt)}</td>
      <td>${tx.amountKc ? `${tx.amountKc} Kč` : formatAmount(tx)}</td>
      <td class="${statusClass(status)}">${status}</td>
      <td>${String(code).slice(0, 28)}</td>
      <td>${tx.product_summary || tx.note || tx.description || '–'}</td>
    </tr>`;
  }).join('');
}

async function loadTransactions() {
  try {
    $('transactionsSummary').textContent = 'Načítám transakce…';
    const data = await request('/api/transactions?limit=20');
    const items = data.items || data.transactions || data.data || [];
    renderTransactions(items, data.mock ? 'Testovací režim' : 'SumUp API');
  } catch (err) {
    const local = loadLocalPayments();
    if (local.length) {
      renderTransactions(local, 'Lokální historie v prohlížeči');
      $('transactionsSummary').textContent += ` SumUp API chyba: ${err.message}`;
    } else {
      $('transactionsBody').innerHTML = `<tr><td colspan="5" class="empty">${err.message}</td></tr>`;
      $('transactionsSummary').textContent = 'Transakce se nepodařilo načíst.';
    }
    toast(err.message, 'error');
  }
}

function setupTabs() {
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      $(`tab-${btn.dataset.tab}`).classList.add('active');
      if (btn.dataset.tab === 'transactions') loadTransactions();
    });
  });
}

function setupEvents() {
  document.querySelectorAll('[data-amount]').forEach(btn => btn.addEventListener('click', () => {
    $('amount').value = btn.dataset.amount;
    $('amount').focus();
  }));
  $('sendPayment').addEventListener('click', sendPayment);
  $('terminatePayment').addEventListener('click', terminatePayment);
  $('refreshStatus').addEventListener('click', pollStatus);
  $('pairReader').addEventListener('click', pairReader);
  $('listReaders').addEventListener('click', listReaders);
  $('forgetReader').addEventListener('click', forgetReader);
  $('loadTransactions').addEventListener('click', loadTransactions);
  $('amount').addEventListener('keydown', e => { if (e.key === 'Enter') sendPayment(); });
}

(async function init() {
  try {
    setupTabs();
    setupEvents();
    await loadConfig();
    const last = localStorage.getItem('lastPayment');
    if (last) {
      const p = JSON.parse(last);
      $('lastTransaction').textContent = p.clientId ? `${p.amountKc} Kč / ${p.clientId.slice(0, 8)}…` : `${p.amountKc} Kč`;
    }
    await pollStatus();
    state.statusTimer = setInterval(pollStatus, 4000);
  } catch (err) {
    setPaymentState('Aplikace nenaběhla', 'error');
    toast(err.message, 'error');
  }
})();
