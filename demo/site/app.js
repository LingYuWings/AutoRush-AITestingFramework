// Connect the equipment request form to the demo's catalog and receipt API.
const form = document.getElementById('request-form')
const item = document.getElementById('item')
const quantity = document.getElementById('quantity')
const limit = document.getElementById('limit')
const status = document.getElementById('status')
const receipt = document.getElementById('receipt')
const error = document.getElementById('error')
const controls = [item, quantity, document.getElementById('submit'), document.getElementById('reset')]
let catalog = []

// Display the quantity limit for the selected piece of equipment.
function updateLimit() {
  const selected = catalog.find(entry => entry.id === item.value)
  quantity.max = selected.limit
  limit.textContent = `每次最多可领用 ${selected.limit} 件`
}

// Toggle the controls while loading the catalog or sending a request.
function setDisabled(disabled) {
  for (const control of controls) control.disabled = disabled
}

// Set the receipt state and hide any feedback from the previous submission.
function showStatus(message) {
  status.textContent = message
  receipt.hidden = true
  error.hidden = true
}

// Load the sample equipment before enabling the form.
async function loadCatalog() {
  try {
    const response = await fetch('/api/catalog')
    if (!response.ok) throw new Error()
    catalog = (await response.json()).items
    item.replaceChildren(...catalog.map(entry => new Option(entry.name, entry.id)))
    updateLimit()
    setDisabled(false)
  } catch {
    showStatus('设备加载失败')
    error.textContent = '请确认演示服务仍在运行，然后刷新页面。'
    error.hidden = false
  }
}

// Submit to the same validation API used by the structured API case.
async function submitRequest(event) {
  event.preventDefault()
  const request = { item_id: item.value, quantity: quantity.valueAsNumber }
  showStatus('正在提交')
  setDisabled(true)
  try {
    const response = await fetch('/api/requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    })
    const result = await response.json()
    if (!response.ok) {
      showStatus('提交被拒绝')
      error.textContent = result.message
      error.hidden = false
      return
    }
    showStatus('提交成功')
    receipt.textContent = `${result.name} × ${result.quantity}`
    receipt.hidden = false
  } catch {
    showStatus('提交失败')
    error.textContent = '无法连接演示服务，请稍后重试。'
    error.hidden = false
  } finally {
    setDisabled(false)
  }
}

// Clear feedback and refresh the limit after the native form reset runs.
function resetForm() {
  showStatus('等待提交')
  queueMicrotask(updateLimit)
}

item.addEventListener('change', updateLimit)
form.addEventListener('submit', submitRequest)
form.addEventListener('reset', resetForm)
void loadCatalog()
