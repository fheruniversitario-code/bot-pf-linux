// ==============================================================================
// OMNIBOT SAAS - FRONTEND CONTROLLER (SPA)
// ==============================================================================

const token = localStorage.getItem('omnibot_token');
if (!token && !window.location.pathname.includes('login.html')) {
    window.location.href = '/login.html';
}

const socket = io();
let chatActivoJid = null;
let currentTab = 'ventas';
let listaEtiquetasMem = [];
let listaConversacionesMem = [];
let filtroEtiquetaActiva = 'todas';
let listaReglasSeguimientoMem = [];

// ------------------------------------------------------------------------------
// 1. HELPERS DE API CON AUTENTICACIÓN
// ------------------------------------------------------------------------------
async function apiFetch(endpoint, options = {}) {
    const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
    const defaultHeaders = {
        'Authorization': `Bearer ${token}`
    };
    if (!isFormData) {
        defaultHeaders['Content-Type'] = 'application/json';
    }

    const res = await fetch(endpoint, {
        ...options,
        headers: { ...defaultHeaders, ...(options.headers || {}) }
    });

    if (res.status === 401 || res.status === 403) {
        cerrarSesion();
        throw new Error('Sesión expirada');
    }

    return res.json();
}

function cerrarSesion() {
    localStorage.removeItem('omnibot_token');
    localStorage.removeItem('omnibot_user');
    window.location.href = '/login.html';
}

// Inicializar datos del usuario logueado en la interfaz
const usuarioActual = JSON.parse(localStorage.getItem('omnibot_user') || '{}');
if (usuarioActual && usuarioActual.nombre) {
    const disp = document.getElementById('user-display-name');
    if (disp) disp.textContent = usuarioActual.nombre.split(' ')[0] || usuarioActual.username;
    const badge = document.getElementById('user-avatar-badge');
    if (badge) badge.textContent = (usuarioActual.nombre[0] || usuarioActual.username[0] || 'U').toUpperCase();
    if (usuarioActual.username === 'admin' || usuarioActual.rol === 'admin') {
        const linkSuper = document.getElementById('link-superadmin');
        if (linkSuper) linkSuper.classList.remove('hidden');
    }
}

function abrirModalMiCuenta() {
    const usuario = JSON.parse(localStorage.getItem('omnibot_user') || '{}');
    document.getElementById('perfil-nombre').value = usuario.nombre || '';
    document.getElementById('perfil-username').value = usuario.username || '';
    document.getElementById('perfil-pass-actual').value = '';
    document.getElementById('perfil-pass-nuevo').value = '';
    document.getElementById('modal-mi-cuenta').classList.remove('hidden');
}

function cerrarModalMiCuenta() {
    document.getElementById('modal-mi-cuenta').classList.add('hidden');
}

async function guardarMiCuenta(e) {
    e.preventDefault();
    try {
        const nuevo_nombre = document.getElementById('perfil-nombre').value.trim();
        const nuevo_username = document.getElementById('perfil-username').value.trim();
        const password_actual = document.getElementById('perfil-pass-actual').value;
        const nuevo_password = document.getElementById('perfil-pass-nuevo').value;

        await apiFetch('/api/perfil/cambiar-password', {
            method: 'POST',
            body: JSON.stringify({ nuevo_nombre, nuevo_username, password_actual, nuevo_password })
        });

        const userObj = JSON.parse(localStorage.getItem('omnibot_user') || '{}');
        userObj.nombre = nuevo_nombre;
        userObj.username = nuevo_username;
        localStorage.setItem('omnibot_user', JSON.stringify(userObj));

        alert("¡Credenciales actualizadas con éxito!");
        cerrarModalMiCuenta();
        window.location.reload();
    } catch (err) {
        alert("Error: " + err.message);
    }
}

// ------------------------------------------------------------------------------
// 2. NAVEGACIÓN Y CAMBIO DE PESTAÑAS (SPA)
// ------------------------------------------------------------------------------
const TITULOS_TABS = {
    ventas: { titulo: "Reporte de ventas", subtitulo: "Ingresos, conversión y cotizaciones pendientes" },
    conversaciones: { titulo: "Conversaciones en Vivo", subtitulo: "Historial y monitoreo de chats con intervención humana" },
    citas: { titulo: "Agenda de Citas", subtitulo: "Control de pacientes y servicios programados" },
    linktree: { titulo: "Página de Enlaces", subtitulo: "Tu propia página pública estilo Linktree para redes sociales" },
    conocimiento: { titulo: "Conocimiento IA", subtitulo: "Instrucciones, prompt y datos de pago de tu asistente" },
    configuracion: { titulo: "Configuración y Respaldos", subtitulo: "Parámetros del sistema y descarga de base de datos" }
};

function cambiarTab(tabId) {
    currentTab = tabId;

    // Actualizar Botones Sidebar
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.className = "nav-btn flex items-center space-x-3 px-3.5 py-2.5 rounded-xl text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 transition";
    });
    const activo = document.getElementById(`nav-${tabId}`);
    if (activo) activo.className = "nav-btn flex items-center space-x-3 px-3.5 py-2.5 rounded-xl bg-indigo-600 text-white shadow-md shadow-indigo-600/20 transition";

    // Ocultar vistas y mostrar activa
    document.querySelectorAll('.tab-view').forEach(view => view.classList.add('hidden'));
    const vistaActiva = document.getElementById(`view-${tabId}`);
    if (vistaActiva) vistaActiva.classList.remove('hidden');

    // Actualizar Header
    const meta = TITULOS_TABS[tabId] || { titulo: "Dashboard", subtitulo: "" };
    document.getElementById('tab-titulo').textContent = meta.titulo;
    document.getElementById('tab-subtitulo').textContent = meta.subtitulo;

    // Cargar datos de la pestaña
    if (tabId === 'ventas') cargarVentasYCRM();
    if (tabId === 'conversaciones') { 
        const badgeNuevos = document.getElementById('badge-mensajes-nuevos');
        if (badgeNuevos) badgeNuevos.classList.add('hidden');
        cargarListaConversaciones(); 
        cargarSolicitudesAsesor(); 
    }
    if (tabId === 'citas') cargarAgendaCitas();
    if (tabId === 'linktree') cargarLinktreeConfig();
    if (tabId === 'conocimiento') cargarConfiguracion();
    if (tabId === 'configuracion') { 
        cargarConfiguracion(); 
        cargarReglasSeguimiento(); 
        cargarSeguimientosPendientes(); 
    }

    // Mantener siempre sincronizado el banner de estado del bot en tiempo real
    cargarEstadoControlBot();
}

// ------------------------------------------------------------------------------
// 3. TAB 1: REPORTE DE VENTAS & CRM
// ------------------------------------------------------------------------------
async function cargarVentasYCRM() {
    try {
        const stats = await apiFetch('/api/stats');
        document.getElementById('kpi-vendido-total').textContent = `$${parseFloat(stats.vendido_total || 0).toLocaleString('es-MX')}`;
        document.getElementById('kpi-pendiente-pago').textContent = `$${parseFloat(stats.pendiente_pago || 0).toLocaleString('es-MX')}`;
        document.getElementById('kpi-pendientes-count').textContent = stats.pedidos_pendientes_count || 0;
        document.getElementById('kpi-cotizaciones-sin-cerrar').textContent = stats.cotizaciones_sin_cerrar || 0;
        document.getElementById('kpi-total-contactos').textContent = stats.total_contactos || 0;

        actualizarBadgeWhatsApp(stats.conectado);

        const pedidos = await apiFetch('/api/pedidos');
        const tbody = document.getElementById('tabla-pedidos-body');
        tbody.innerHTML = '';

        if (!pedidos || pedidos.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" class="py-8 text-center text-slate-500 text-xs">No hay cotizaciones o pedidos registrados aún.</td></tr>`;
            return;
        }

        pedidos.forEach(p => {
            const tr = document.createElement('tr');
            tr.className = "hover:bg-slate-850/40 transition";
            
            let colorBadge = "bg-amber-500/10 text-amber-400 border-amber-500/20";
            if (p.estado === 'Pagado') colorBadge = "bg-emerald-500/10 text-emerald-400 border-emerald-500/20";
            if (p.estado === 'Contactado') colorBadge = "bg-indigo-500/10 text-indigo-400 border-indigo-500/20";
            if (p.estado === 'Cancelado') colorBadge = "bg-rose-500/10 text-rose-400 border-rose-500/20";

            tr.innerHTML = `
                <td class="py-4">
                    <div class="font-bold text-white">${p.cliente_nombre || 'Cliente'}</div>
                    <div class="text-xs text-slate-400">${p.cliente_telefono || ''}</div>
                </td>
                <td class="py-4 font-medium text-slate-200">${p.producto_servicio || 'Consulta General'}</td>
                <td class="py-4 font-extrabold text-white">$${parseFloat(p.valor || 0).toLocaleString('es-MX')}</td>
                <td class="py-4">
                    <select onchange="cambiarEstadoPedido(${p.id}, this.value)" class="px-3 py-1 rounded-full text-xs font-semibold border ${colorBadge} bg-slate-900 focus:outline-none cursor-pointer">
                        <option value="Nuevo" ${p.estado === 'Nuevo' ? 'selected' : ''}>Nuevo</option>
                        <option value="Contactado" ${p.estado === 'Contactado' ? 'selected' : ''}>Contactado</option>
                        <option value="Pendiente de pago" ${p.estado === 'Pendiente de pago' ? 'selected' : ''}>Pendiente de pago</option>
                        <option value="Pagado" ${p.estado === 'Pagado' ? 'selected' : ''}>Pagado</option>
                        <option value="Cancelado" ${p.estado === 'Cancelado' ? 'selected' : ''}>Cancelado</option>
                    </select>
                </td>
                <td class="py-4 text-xs text-slate-400">${new Date(p.timestamp).toLocaleDateString('es-MX')}</td>
                <td class="py-4 text-right">
                    <button onclick="abrirChatDirecto('${p.cliente_telefono}')" class="text-indigo-400 hover:text-indigo-300 text-xs font-semibold">
                        Ver Chat <i class="fa-solid fa-arrow-right text-[10px] ml-1"></i>
                    </button>
                </td>
            `;
            tbody.appendChild(tr);
        });
        cargarSolicitudesAsesor();
    } catch (e) {
        console.error("Error cargando CRM:", e);
    }
}

async function cambiarEstadoPedido(id, nuevoEstado) {
    try {
        await apiFetch(`/api/pedidos/${id}/estado`, {
            method: 'PATCH',
            body: JSON.stringify({ estado: nuevoEstado })
        });
        cargarVentasYCRM();
    } catch (e) {
        alert("Error al actualizar estado: " + e.message);
    }
}

// ------------------------------------------------------------------------------
// 3.1 GESTIÓN DE SOLICITUDES DE ASESOR FUERA DE HORARIO
// ------------------------------------------------------------------------------
let listaSolicitudesAsesorMem = [];

async function cargarSolicitudesAsesor() {
    try {
        const solicitudes = await apiFetch('/api/solicitudes-asesor');
        listaSolicitudesAsesorMem = solicitudes || [];

        const pendientes = listaSolicitudesAsesorMem.filter(s => s.estado === 'pendiente');
        const countBadge = document.getElementById('count-pendientes-asesor');
        if (countBadge) countBadge.textContent = pendientes.length;

        const tbody = document.getElementById('tabla-solicitudes-asesor-body');
        if (!tbody) return;
        tbody.innerHTML = '';

        if (!solicitudes || solicitudes.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" class="py-8 text-center text-slate-500 text-xs">No hay solicitudes de asesor pendientes.</td></tr>`;
            return;
        }

        solicitudes.forEach(s => {
            const tr = document.createElement('tr');
            tr.className = "hover:bg-slate-850/40 transition";
            const esPendiente = s.estado === 'pendiente';

            tr.innerHTML = `
                <td class="py-4">
                    <div class="font-bold text-white flex items-center space-x-2">
                        <span class="w-6 h-6 rounded-full ${esPendiente ? 'bg-amber-500/20 text-amber-300' : 'bg-emerald-500/20 text-emerald-300'} flex items-center justify-center text-[10px] font-bold">
                            ${(s.nombre || 'P').charAt(0).toUpperCase()}
                        </span>
                        <span>${s.nombre || 'Paciente'}</span>
                    </div>
                </td>
                <td class="py-4 text-xs font-mono text-slate-300">
                    <a href="https://wa.me/${(s.telefono || '').replace(/[^0-9]/g, '')}" target="_blank" class="hover:text-emerald-400 flex items-center space-x-1">
                        <i class="fa-brands fa-whatsapp text-emerald-400"></i>
                        <span>+${s.telefono || ''}</span>
                    </a>
                </td>
                <td class="py-4 text-xs text-slate-200 max-w-xs truncate" title="${s.motivo || ''}">${s.motivo || 'Solicitud de Asesor'}</td>
                <td class="py-4 text-xs text-slate-400">${s.fecha_hora || new Date(s.timestamp).toLocaleString('es-MX')}</td>
                <td class="py-4">
                    <span class="px-2.5 py-1 rounded-full text-[11px] font-bold border ${esPendiente ? 'bg-amber-500/10 text-amber-400 border-amber-500/30' : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'}">
                        ${esPendiente ? '⏳ Pendiente' : '✅ Atendido'}
                    </span>
                </td>
                <td class="py-4 text-right space-x-2">
                    <button onclick="abrirChatDirecto('${s.jid || (s.telefono + '@c.us')}')" class="px-2.5 py-1 bg-indigo-600/20 hover:bg-indigo-600/40 text-indigo-300 border border-indigo-500/30 rounded-lg text-xs font-semibold transition" title="Abrir en Chat">
                        <i class="fa-solid fa-comments mr-1"></i>Chat
                    </button>
                    <button onclick="cambiarEstadoSolicitudAsesor(${s.id}, '${esPendiente ? 'atendido' : 'pendiente'}')" class="px-2.5 py-1 ${esPendiente ? 'bg-emerald-600/20 hover:bg-emerald-600/40 text-emerald-300 border-emerald-500/30' : 'bg-slate-800 text-slate-400 hover:text-white border-slate-700'} border rounded-lg text-xs font-semibold transition" title="${esPendiente ? 'Marcar como atendido' : 'Marcar como pendiente'}">
                        <i class="fa-solid ${esPendiente ? 'fa-check' : 'fa-rotate-left'}"></i>
                    </button>
                    <button onclick="eliminarSolicitudAsesor(${s.id})" class="text-slate-500 hover:text-rose-400 text-xs transition" title="Eliminar registro">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </td>
            `;
            tbody.appendChild(tr);
        });
    } catch(e) {
        console.error("Error al cargar solicitudes de asesor:", e);
    }
}

async function cambiarEstadoSolicitudAsesor(id, nuevoEstado) {
    try {
        await apiFetch(`/api/solicitudes-asesor/${id}/estado`, {
            method: 'POST',
            body: JSON.stringify({ estado: nuevoEstado })
        });
        cargarSolicitudesAsesor();
    } catch (e) {
        alert("Error al actualizar estado: " + e.message);
    }
}

async function eliminarSolicitudAsesor(id) {
    if (!confirm("¿Deseas eliminar este registro de solicitud?")) return;
    try {
        await apiFetch(`/api/solicitudes-asesor/${id}`, {
            method: 'DELETE'
        });
        cargarSolicitudesAsesor();
    } catch (e) {
        alert("Error al eliminar solicitud: " + e.message);
    }
}

let filtroPendientesActivo = false;

async function filtrarChatsPendientesAsesor() {
    await cargarSolicitudesAsesor();
    const pendientes = listaSolicitudesAsesorMem.filter(s => s.estado === 'pendiente');
    
    if (pendientes.length === 0 && !filtroPendientesActivo) {
        alert("ℹ️ No hay solicitudes de asesor pendientes actualmente.");
        return;
    }

    filtroPendientesActivo = !filtroPendientesActivo;
    const badge = document.getElementById('badge-pendientes-asesor');
    if (badge) {
        if (filtroPendientesActivo) {
            badge.className = "cursor-pointer px-2.5 py-1 bg-amber-500/30 text-amber-300 border border-amber-400 rounded-lg text-[11px] font-bold flex items-center space-x-1 transition ring-2 ring-amber-400/60 shadow-md";
        } else {
            badge.className = "cursor-pointer px-2.5 py-1 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 border border-amber-500/30 rounded-lg text-[11px] font-bold flex items-center space-x-1 transition";
        }
    }

    aplicarFiltrosConversaciones();

    // Si se activa y hay pendientes, seleccionar el primero
    if (filtroPendientesActivo && pendientes.length > 0) {
        const primero = pendientes[0];
        if (primero && primero.jid) {
            seleccionarChat(primero.jid, primero.nombre || primero.telefono);
        }
    }
}

// ------------------------------------------------------------------------------
// 4. TAB 2: CONVERSACIONES LIVE CHAT CON ETIQUETAS Y TIEMPO RELATIVO
// ------------------------------------------------------------------------------

async function cargarEtiquetasFiltro() {
    try {
        listaEtiquetasMem = await apiFetch('/api/etiquetas');
        const cont = document.getElementById('lista-filtros-etiquetas');
        if (!cont) return;

        // Si la etiqueta activa ya no existe, volver a 'todas'
        if (filtroEtiquetaActiva !== 'todas' && !listaEtiquetasMem.some(e => String(e.id) === String(filtroEtiquetaActiva))) {
            filtroEtiquetaActiva = 'todas';
        }

        cont.innerHTML = `
            <button onclick="filtrarPorEtiqueta('todas')" class="etiqueta-filtro-btn px-2.5 py-1 rounded-lg text-white font-bold text-[11px] whitespace-nowrap transition ${filtroEtiquetaActiva === 'todas' ? 'bg-indigo-600 shadow-sm' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}" data-etiqueta="todas">
                Todas (${listaConversacionesMem.length})
            </button>
        `;

        listaEtiquetasMem.forEach(etq => {
            const esActiva = filtroEtiquetaActiva === String(etq.id);
            const btn = document.createElement('button');
            btn.className = `etiqueta-filtro-btn px-2.5 py-1 rounded-lg text-[11px] font-bold whitespace-nowrap transition flex items-center space-x-1.5 ${esActiva ? 'text-white shadow-sm' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`;
            if (esActiva) btn.style.backgroundColor = etq.color;
            btn.onclick = () => filtrarPorEtiqueta(String(etq.id));
            btn.innerHTML = `
                <span class="w-2 h-2 rounded-full flex-shrink-0" style="background-color: ${etq.color};"></span>
                <span>${etq.nombre}</span>
                <span class="text-[9px] opacity-75">(${etq.total_contactos || 0})</span>
            `;
            cont.appendChild(btn);
        });

        // Actualizar selectores de etiquetas en modales
        const selectRegla = document.getElementById('select-regla-etiqueta');
        if (selectRegla) {
            selectRegla.innerHTML = '<option value="">(Aplica a Todos los Clientes)</option>';
            listaEtiquetasMem.forEach(e => {
                selectRegla.innerHTML += `<option value="${e.id}">${e.nombre}</option>`;
            });
        }
    } catch (e) {
        console.error("Error al cargar etiquetas:", e);
    }
}

function filtrarPorEtiqueta(etiquetaId) {
    filtroPendientesActivo = false;
    const badge = document.getElementById('badge-pendientes-asesor');
    if (badge) {
        badge.className = "cursor-pointer px-2.5 py-1 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 border border-amber-500/30 rounded-lg text-[11px] font-bold flex items-center space-x-1 transition";
    }
    filtroEtiquetaActiva = etiquetaId;
    cargarEtiquetasFiltro();
    aplicarFiltrosConversaciones();
}

let debounceTimerBusqueda = null;

function aplicarFiltrosConversaciones() {
    const busqueda = (document.getElementById('buscar-chat-input')?.value || '').toLowerCase().trim();
    const telDigits = busqueda.replace(/[^0-9]/g, '');
    let filtrados = listaConversacionesMem;

    if (filtroPendientesActivo) {
        const pendientes = listaSolicitudesAsesorMem.filter(s => s.estado === 'pendiente');
        const jidsPendientes = pendientes.map(s => s.jid);
        const telsPendientes = pendientes.map(s => (s.telefono || '').replace(/[^0-9]/g, '')).filter(t => t.length >= 6);

        filtrados = filtrados.filter(c => {
            const telC = (c.telefono || c.jid || '').replace(/[^0-9]/g, '');
            return jidsPendientes.includes(c.jid) || (telC && telsPendientes.some(t => telC.includes(t) || t.includes(telC)));
        });
    } else if (filtroEtiquetaActiva !== 'todas') {
        const idNum = parseInt(filtroEtiquetaActiva, 10);
        filtrados = filtrados.filter(c => c.etiquetas_lista && c.etiquetas_lista.some(t => t.id === idNum));
    }

    if (busqueda) {
        filtrados = filtrados.filter(c => {
            const telC = (c.telefono || '').replace(/[^0-9]/g, '');
            const jidClean = (c.jid || '').toLowerCase();
            return (c.nombre && c.nombre.toLowerCase().includes(busqueda)) ||
                (c.pushname && c.pushname.toLowerCase().includes(busqueda)) ||
                (c.telefono && c.telefono.includes(busqueda)) ||
                (telDigits.length >= 4 && telC.includes(telDigits)) ||
                (jidClean.includes(busqueda)) ||
                (c.ultimo_mensaje && c.ultimo_mensaje.toLowerCase().includes(busqueda));
        });
    }

    renderizarListaConversaciones(filtrados);

    // Si la búsqueda tiene al menos 3 caracteres, buscar también en el servidor para traer conversaciones no cargadas en memoria
    if (busqueda.length >= 3) {
        clearTimeout(debounceTimerBusqueda);
        debounceTimerBusqueda = setTimeout(async () => {
            try {
                const resServidor = await apiFetch(`/api/conversaciones?q=${encodeURIComponent(busqueda)}`);
                if (resServidor && resServidor.length > 0) {
                    for (const r of resServidor) {
                        const idx = listaConversacionesMem.findIndex(x => x.jid === r.jid);
                        if (idx >= 0) {
                            listaConversacionesMem[idx] = r;
                        } else {
                            listaConversacionesMem.unshift(r);
                        }
                    }
                    const busqActual = (document.getElementById('buscar-chat-input')?.value || '').toLowerCase().trim();
                    if (busqActual === busqueda) {
                        renderizarListaConversaciones(resServidor);
                    }
                }
            } catch (errBusq) {
                console.error("Error en búsqueda remota:", errBusq);
            }
        }, 350);
    }
}

// Búsqueda en tiempo real
document.getElementById('buscar-chat-input')?.addEventListener('input', aplicarFiltrosConversaciones);

async function cargarListaConversaciones() {
    try {
        listaConversacionesMem = await apiFetch('/api/conversaciones');
        await cargarEtiquetasFiltro();
        aplicarFiltrosConversaciones();
    } catch (e) {
        console.error("Error cargando chats:", e);
    }
}

function renderizarListaConversaciones(chats) {
    const cont = document.getElementById('lista-chats-container');
    if (!cont) return;
    cont.innerHTML = '';

    if (!chats || chats.length === 0) {
        cont.innerHTML = `<div class="p-8 text-center text-xs text-slate-500">No se encontraron conversaciones con este filtro</div>`;
        return;
    }

    chats.forEach(c => {
        const div = document.createElement('div');
        div.className = `p-3.5 cursor-pointer hover:bg-slate-800/60 transition flex items-start space-x-3 ${chatActivoJid === c.jid ? 'bg-slate-800/80 border-l-4 border-indigo-500' : ''}`;
        div.onclick = () => seleccionarChat(c.jid, c.nombre || c.pushname || c.telefono, c.telefono);

        const badgeIA = c.ultimo_fue_ia ? '<span class="text-[9px] px-1.5 py-0.2 bg-indigo-500/20 text-indigo-300 rounded font-bold">IA</span>' : '';
        const tiempoRelativo = c.tiempo_relativo || 'reciente';

        // Renderizar Badges de Etiquetas con Colores
        let tagsHtml = '';
        if (c.etiquetas_lista && c.etiquetas_lista.length > 0) {
            tagsHtml = c.etiquetas_lista.map(t => `
                <span class="inline-flex items-center space-x-1 px-1.5 py-0.5 rounded text-[9px] font-bold text-white shadow-xs" style="background-color: ${t.color};">
                    <span>${t.nombre}</span>
                </span>
            `).join('');
        }

        const esGrupo = c.jid && c.jid.endsWith('@g.us');
        const avatarHtml = esGrupo
            ? `<div class="w-10 h-10 rounded-full bg-pink-950/40 border border-pink-500/30 flex items-center justify-center font-bold text-xs text-pink-300 flex-shrink-0 mt-0.5 shadow-sm" title="Grupo">
                   <i class="fa-solid fa-users text-pink-400 text-xs"></i>
               </div>`
            : `<div class="w-10 h-10 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center font-bold text-xs text-slate-200 flex-shrink-0 mt-0.5 shadow-sm">
                   ${(c.nombre || c.pushname || 'C').charAt(0).toUpperCase()}
               </div>`;

        const esPendienteAsesor = listaSolicitudesAsesorMem.some(s => {
            if (s.estado !== 'pendiente') return false;
            const telC = (c.telefono || c.jid || '').replace(/[^0-9]/g, '');
            const telS = (s.telefono || s.jid || '').replace(/[^0-9]/g, '');
            return s.jid === c.jid || (telC && telS && (telC.includes(telS) || telS.includes(telC)));
        });
        const badgePendiente = esPendienteAsesor ? '<span class="text-[9px] px-1.5 py-0.2 bg-amber-500/20 text-amber-300 border border-amber-500/40 rounded font-bold flex items-center space-x-1 shadow-xs"><i class="fa-solid fa-bell text-[8px]"></i><span>Asesor</span></span>' : '';

        const badgeGrupo = esGrupo ? '<span class="text-[9px] px-1.5 py-0.2 bg-pink-500/20 text-pink-300 rounded font-bold">Grupo</span>' : '';

        div.innerHTML = `
            ${avatarHtml}
            <div class="flex-1 min-w-0">
                <div class="flex items-center justify-between">
                    <h4 class="font-bold text-white text-xs truncate">${c.nombre || c.pushname || c.telefono}</h4>
                    <div class="flex items-center space-x-1.5">
                        ${badgePendiente}
                        ${badgeGrupo}
                        ${badgeIA}
                    </div>
                </div>

                <p class="text-[11px] text-slate-400 truncate mt-0.5">${c.ultimo_mensaje || 'Sin mensajes'}</p>

                <div class="flex items-center justify-between mt-1.5 pt-1 border-t border-slate-800/40 text-[10px] text-slate-500">
                    <span class="flex items-center space-x-1 text-slate-400 font-medium">
                        <i class="fa-regular fa-clock text-[9px]"></i>
                        <span>${tiempoRelativo}</span>
                    </span>
                    <div class="flex items-center space-x-1 overflow-hidden max-w-[50%]">
                        ${tagsHtml}
                    </div>
                </div>
            </div>
        `;
        cont.appendChild(div);
    });
}

async function refrescarChatActivo() {
    if (!chatActivoJid) return;
    const btn = document.getElementById('btn-refrescar-chat');
    if (btn) btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin text-emerald-400"></i> <span>Sincronizando...</span>';
    await seleccionarChat(chatActivoJid, document.getElementById('chat-nombre-cliente').textContent);
}

async function resolverSolicitudAsesorDesdeChat(id) {
    try {
        await apiFetch(`/api/solicitudes-asesor/${id}/estado`, {
            method: 'POST',
            body: JSON.stringify({ estado: 'atendido' })
        });
        await cargarSolicitudesAsesor();
        const banner = document.getElementById('banner-asesor-solicitud');
        if (banner) banner.remove();
        aplicarFiltrosConversaciones();
    } catch(e) {
        alert("Error al resolver solicitud: " + e.message);
    }
}

async function seleccionarChat(jid, nombre, telefono = '') {
    chatActivoJid = jid;
    document.getElementById('chat-nombre-cliente').textContent = nombre;
    let telMostrar = telefono || (jid.endsWith('@c.us') ? jid.replace('@c.us', '') : '');
    if (telMostrar && (telMostrar.startsWith('1660') || telMostrar.length > 13)) telMostrar = '';
    document.getElementById('chat-telefono-cliente').textContent = telMostrar ? `+${telMostrar}` : (jid.endsWith('@lid') ? 'WhatsApp' : jid.replace('@c.us', ''));
    document.getElementById('chat-avatar').textContent = (nombre || 'C').charAt(0).toUpperCase();

    // Mostrar botón de gestionar etiquetas
    const btnEtq = document.getElementById('btn-gestionar-etiquetas');
    if (btnEtq) btnEtq.classList.remove('hidden');

    const stream = document.getElementById('chat-mensajes-stream');
    stream.innerHTML = '<div class="h-full flex items-center justify-center text-slate-500 text-xs">Cargando mensajes...</div>';

    try {
        const [data, tagsContacto] = await Promise.all([
            apiFetch(`/api/conversaciones/${encodeURIComponent(jid)}/mensajes`),
            apiFetch(`/api/contactos/${encodeURIComponent(jid)}/etiquetas`)
        ]);

        stream.innerHTML = '';

        // Renderizar Badges de Etiquetas en el Header del Chat
        const badgesCont = document.getElementById('chat-etiquetas-badges');
        if (badgesCont) {
            badgesCont.innerHTML = (tagsContacto || []).map(t => `
                <span class="px-2 py-0.5 rounded-full text-[10px] font-bold text-white shadow-xs flex items-center space-x-1" style="background-color: ${t.color};">
                    <span class="w-1.5 h-1.5 rounded-full bg-white"></span>
                    <span>${t.nombre}</span>
                </span>
            `).join('');
        }

        // Botón de Sincronizar, Etiquetas, Reanudar Bot e Ignorar / Reactivar Contacto en 1 Clic
        const accionesCont = document.getElementById('chat-acciones');
        if (accionesCont) {
            const esIgnorado = data.contacto && data.contacto.es_ignorado === 1;
            accionesCont.innerHTML = `
                <button id="btn-refrescar-chat" onclick="refrescarChatActivo()" class="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-semibold flex items-center space-x-1.5 transition shadow-sm" title="Sincronizar mensajes de WhatsApp">
                    <i class="fa-solid fa-arrows-rotate text-emerald-400"></i>
                    <span>Sincronizar</span>
                </button>
                <button id="btn-reanudar-bot-chat" onclick="reanudarBotChatActivo('${jid}')" class="px-3 py-1.5 bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border border-emerald-500/40 rounded-xl text-xs font-semibold flex items-center space-x-1.5 transition shadow-sm" title="El bot continuará atendiendo a este cliente con IA manteniendo el contexto">
                    <i class="fa-solid fa-robot text-emerald-400"></i>
                    <span>Reanudar Bot</span>
                </button>
                <button id="btn-gestionar-etiquetas" onclick="abrirModalEtiquetasContacto()" class="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-semibold flex items-center space-x-1.5 transition shadow-sm" title="Asignar Etiquetas / Listas">
                    <i class="fa-solid fa-tags text-indigo-400"></i>
                    <span>Etiquetas</span>
                </button>
                <button onclick="toggleIgnorarChatActual('${jid}', ${esIgnorado ? 0 : 1})" class="px-3.5 py-1.5 ${esIgnorado ? 'bg-rose-500/20 text-rose-300 border-rose-500/40 hover:bg-rose-500/30' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'} border rounded-xl text-xs font-semibold flex items-center space-x-1.5 transition shadow-sm">
                    <i class="fa-solid ${esIgnorado ? 'fa-user-slash text-rose-400' : 'fa-user-check text-slate-400'}"></i>
                    <span>${esIgnorado ? 'Contacto Ignorado (Click para Reactivar)' : 'Ignorar Contacto (1 Clic)'}</span>
                </button>
            `;
        }

        // Mostrar banner destacado si este paciente solicitó asesor
        const telContactoLimpio = (jid || '').replace(/[^0-9]/g, '');
        const solicitudPendiente = listaSolicitudesAsesorMem.find(s => {
            if (s.estado !== 'pendiente') return false;
            const telS = (s.telefono || s.jid || '').replace(/[^0-9]/g, '');
            return s.jid === jid || (telContactoLimpio && telS && (telContactoLimpio.includes(telS) || telS.includes(telContactoLimpio)));
        });

        const bannerExistente = document.getElementById('banner-asesor-solicitud');
        if (bannerExistente) bannerExistente.remove();

        if (solicitudPendiente) {
            const banner = document.createElement('div');
            banner.id = 'banner-asesor-solicitud';
            banner.className = 'px-6 py-2.5 bg-amber-950/60 border-b border-amber-500/40 flex items-center justify-between text-xs';
            banner.innerHTML = `
                <div class="flex items-center space-x-2 text-amber-300">
                    <i class="fa-solid fa-bell text-amber-400 text-sm"></i>
                    <span>Solicitó asesor en vivo: <b>"${solicitudPendiente.motivo || 'Atención personalizada'}"</b> (${solicitudPendiente.fecha_hora || 'reciente'})</span>
                </div>
                <button onclick="resolverSolicitudAsesorDesdeChat(${solicitudPendiente.id})" class="px-3 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-bold transition shadow-sm flex items-center space-x-1">
                    <i class="fa-solid fa-check"></i>
                    <span>Marcar Atendido</span>
                </button>
            `;
            const header = document.getElementById('chat-header');
            if (header && header.parentNode) {
                header.parentNode.insertBefore(banner, header.nextSibling);
            }
        }

        if (!data.mensajes || data.mensajes.length === 0) {
            stream.innerHTML = '<div class="h-full flex items-center justify-center text-slate-500 text-xs">No hay historial para este chat.</div>';
            return;
        }

        data.mensajes.forEach(m => {
            const isMe = m.es_mio === 1;
            const cuerpoRaw = (m.cuerpo || '').trim();

            // Detección robusta de si el mensaje proviene de la IA (Gemini / Bot)
            const esMensajeIA = isMe && (
                m.es_ia === 1 || 
                m.emisor === 'bot' || 
                m.emisor_nombre === 'Asistente IA' || 
                cuerpoRaw.startsWith('🤖') ||
                cuerpoRaw.startsWith('👨‍⚕️') ||
                cuerpoRaw.startsWith('🏥') ||
                cuerpoRaw.startsWith('🎓') ||
                cuerpoRaw.startsWith('🌴')
            );

            const row = document.createElement('div');
            row.className = `flex flex-col ${isMe ? 'items-end' : 'items-start'}`;

            let nombreMostrar = 'Cliente';
            let badgeEmisor = '';

            if (isMe) {
                if (esMensajeIA) {
                    nombreMostrar = 'Asistente IA';
                    badgeEmisor = '<span class="text-[10px] font-bold text-emerald-400 ml-1.5">IA</span>';
                } else {
                    nombreMostrar = 'Asesor Humano';
                    badgeEmisor = '<span class="text-[10px] font-bold text-indigo-300 ml-1.5">Asesor</span>';
                }
            } else {
                nombreMostrar = m.emisor_nombre || 'Cliente';
            }

            let cuerpoHtml = m.cuerpo || '';
            if (cuerpoHtml.startsWith('/9j/') || cuerpoHtml.startsWith('data:image') || (cuerpoHtml.length > 200 && !cuerpoHtml.includes(' '))) {
                cuerpoHtml = `<div class="flex items-center space-x-2 py-1"><i class="fa-solid fa-image text-sm text-indigo-300"></i> <span class="font-medium">📷 (Infografía / Imagen enviada)</span></div>`;
            } else {
                cuerpoHtml = `<div class="whitespace-pre-wrap leading-relaxed">${cuerpoHtml}</div>`;
            }

            row.innerHTML = `
                <div class="max-w-[75%] rounded-2xl px-4 py-3 text-sm shadow-sm ${isMe ? (esMensajeIA ? 'bg-emerald-950/40 border border-emerald-800/40 text-emerald-100 rounded-tr-none' : 'bg-indigo-600 text-white rounded-tr-none') : 'bg-slate-800 border border-slate-700/60 text-slate-100 rounded-tl-none'}">
                    <div class="text-[10px] font-semibold text-slate-400 mb-1 flex items-center">
                        <span>${nombreMostrar}</span>
                        ${badgeEmisor}
                    </div>
                    ${cuerpoHtml}
                    <div class="text-[9px] text-right mt-1 opacity-60">${new Date(m.timestamp).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: true })}</div>
                </div>
            `;
            stream.appendChild(row);
        });

        stream.scrollTop = stream.scrollHeight;
    } catch (e) {
        console.error("Error al obtener mensajes:", e);
    }
}

async function reanudarBotChatActivo(jid) {
    const targetJid = jid || chatActivoJid;
    if (!targetJid) return alert("Selecciona un chat primero");
    try {
        await apiFetch(`/api/conversaciones/${encodeURIComponent(targetJid)}/reactivar`, { method: 'POST' });
        alert("🤖 ¡Bot reanudado para este chat! A partir de su próximo mensaje, el asistente responderá con IA manteniendo el hilo y contexto de la conversación.");
    } catch (e) {
        alert("Error al reanudar bot: " + e.message);
    }
}

async function toggleIgnorarChatActual(jid, nuevoEstado) {
    try {
        await apiFetch('/api/configuracion/ignorar', {
            method: 'POST',
            body: JSON.stringify({ jid, es_ignorado: nuevoEstado })
        });
        alert(nuevoEstado === 1 ? "🚫 Contacto ignorado con éxito. El bot ya no responderá a este número." : "✅ Contacto reactivado. El bot volverá a responderle.");
        seleccionarChat(jid, document.getElementById('chat-nombre-cliente').textContent);
        cargarListaIgnorados();
    } catch (e) {
        alert("Error: " + e.message);
    }
}

async function renombrarContactoActual() {
    if (!chatActivoJid) return alert("Selecciona un chat primero");
    const nomElem = document.getElementById('chat-nombre-cliente');
    const nomActual = nomElem ? nomElem.textContent : '';
    const nuevoNombre = prompt("Ingresa el nombre correcto para este contacto / paciente:", nomActual !== 'Selecciona una conversación' ? nomActual : '');
    if (!nuevoNombre || !nuevoNombre.trim() || nuevoNombre.trim() === nomActual) return;

    try {
        const res = await apiFetch(`/api/contactos/${encodeURIComponent(chatActivoJid)}/nombre`, {
            method: 'PUT',
            body: JSON.stringify({ nombre: nuevoNombre.trim() })
        });
        if (res.success) {
            nomElem.textContent = res.nombre;
            document.getElementById('chat-avatar').textContent = res.nombre.charAt(0).toUpperCase();
            cargarConversaciones();
            alert(`✅ Contacto renombrado con éxito a: ${res.nombre}`);
        }
    } catch (e) {
        alert("Error al renombrar contacto: " + e.message);
    }
}

// Enviar Mensaje desde el Formulario
document.getElementById('form-enviar-mensaje').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!chatActivoJid) return alert("Selecciona un chat primero");

    const input = document.getElementById('input-mensaje-texto');
    const texto = input.value.trim();
    if (!texto) return;

    input.value = '';
    try {
        await apiFetch(`/api/conversaciones/${encodeURIComponent(chatActivoJid)}/enviar`, {
            method: 'POST',
            body: JSON.stringify({ texto })
        });
        seleccionarChat(chatActivoJid, document.getElementById('chat-nombre-cliente').textContent);
    } catch (e) {
        alert("Error al enviar mensaje: " + e.message);
    }
});

// ------------------------------------------------------------------------------
// 5. TAB 3: AGENDA DE CITAS
// ------------------------------------------------------------------------------
async function cargarAgendaCitas() {
    try {
        const citas = await apiFetch('/api/citas');
        const tbody = document.getElementById('tabla-citas-body');
        tbody.innerHTML = '';

        if (!citas || citas.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" class="py-8 text-center text-slate-500 text-xs">No hay citas agendadas aún.</td></tr>`;
            return;
        }

        citas.forEach(c => {
            const tr = document.createElement('tr');
            tr.className = "hover:bg-slate-850/40 transition";
            tr.innerHTML = `
                <td class="py-4 font-bold text-white">
                    <div>${c.fecha}</div>
                    <div class="text-xs text-indigo-400">${c.hora}</div>
                </td>
                <td class="py-4 font-semibold text-slate-200">${c.cliente_nombre}</td>
                <td class="py-4 text-xs text-slate-400">${c.cliente_telefono}</td>
                <td class="py-4 text-xs font-medium text-slate-300">${c.servicio}</td>
                <td class="py-4"><span class="px-2.5 py-1 bg-emerald-500/10 text-emerald-400 rounded-full text-xs font-bold border border-emerald-500/20">${c.estado}</span></td>
                <td class="py-4 text-xs text-slate-400">${c.notas || '---'}</td>
            `;
            tbody.appendChild(tr);
        });
    } catch (e) {
        console.error("Error cargando citas:", e);
    }
}

function abrirModalNuevaCita() {
    document.getElementById('modal-nueva-cita').classList.remove('hidden');
}

function cerrarModalNuevaCita() {
    document.getElementById('modal-nueva-cita').classList.add('hidden');
}

async function guardarNuevaCita(e) {
    e.preventDefault();
    try {
        const cliente_nombre = document.getElementById('cita-nombre-input').value.trim();
        const cliente_telefono = document.getElementById('cita-telefono-input').value.trim();
        const servicio = document.getElementById('cita-servicio-input').value.trim();
        const fecha = document.getElementById('cita-fecha-input').value;
        const hora = document.getElementById('cita-hora-input').value;
        const notas = document.getElementById('cita-notas-input').value.trim();

        await apiFetch('/api/citas', {
            method: 'POST',
            body: JSON.stringify({
                cliente_nombre,
                cliente_telefono,
                servicio,
                fecha,
                hora,
                notas,
                estado: 'Confirmada'
            })
        });

        alert("¡Cita agendada con éxito!");
        cerrarModalNuevaCita();
        document.getElementById('form-nueva-cita').reset();
        cargarAgendaCitas();
    } catch (err) {
        alert("Error al agendar cita: " + err.message);
    }
}

// ------------------------------------------------------------------------------
// 6. TAB 4: LINKTREE CONFIG
// ------------------------------------------------------------------------------
async function cargarLinktreeConfig() {
    try {
        const data = await apiFetch('/api/linktree');
        if (document.getElementById('linktree-titulo-input')) document.getElementById('linktree-titulo-input').value = data.titulo || '';
        if (document.getElementById('linktree-desc-input')) document.getElementById('linktree-desc-input').value = data.descripcion || '';
        if (document.getElementById('linktree-logo-input')) document.getElementById('linktree-logo-input').value = data.logo_url || '';

        const cont = document.getElementById('lista-links-container');
        cont.innerHTML = '';

        (data.links || []).forEach(l => {
            const div = document.createElement('div');
            div.className = "flex items-center justify-between p-3.5 bg-slate-950 border border-slate-800 rounded-xl";
            div.innerHTML = `
                <div class="flex items-center space-x-3">
                    <i class="fa-solid fa-link text-slate-500 text-sm"></i>
                    <div>
                        <div class="text-xs font-bold text-white">${l.titulo}</div>
                        <div class="text-[10px] text-slate-400">${l.url}</div>
                    </div>
                </div>
                <button onclick="eliminarLinktreeLink(${l.id})" class="text-slate-500 hover:text-rose-400 transition text-xs">
                    <i class="fa-solid fa-trash"></i>
                </button>
            `;
            cont.appendChild(div);
        });

        // Refrescar iframe preview
        const frame = document.getElementById('preview-linktree-frame');
        if (frame) frame.src = '/pagina.html?t=' + Date.now();
    } catch (e) {
        console.error("Error linktree:", e);
    }
}

async function subirArchivoLogo(input) {
    if (!input.files || input.files.length === 0) return;
    const file = input.files[0];
    const formData = new FormData();
    formData.append('logo', file);

    try {
        const res = await fetch('/api/upload/logo', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` },
            body: formData
        });

        if (!res.ok) {
            const errTxt = await res.text();
            throw new Error(`Error en el servidor (${res.status}): ${errTxt.slice(0, 100)}`);
        }

        const data = await res.json();
        if (data.success) {
            document.getElementById('linktree-logo-input').value = data.logo_url;
            alert("✅ Logo subido y guardado con éxito.");
            cargarLinktreeConfig();
        } else {
            alert("Error al subir logo: " + (data.error || 'Error desconocido'));
        }
    } catch (e) {
        alert("Error al subir logo: " + e.message);
    }
    input.value = '';
}

async function guardarConfigLinktree() {
    try {
        await apiFetch('/api/configuracion', {
            method: 'POST',
            body: JSON.stringify({
                linktree_titulo: document.getElementById('linktree-titulo-input').value,
                linktree_descripcion: document.getElementById('linktree-desc-input').value,
                linktree_logo_url: document.getElementById('linktree-logo-input').value
            })
        });
        alert("Configuración y logo de Linktree guardados con éxito.");
        cargarLinktreeConfig();
    } catch (e) {
        alert("Error al guardar: " + e.message);
    }
}

async function eliminarLinktreeLink(id) {
    if (!confirm("¿Eliminar este enlace?")) return;
    try {
        await apiFetch(`/api/linktree/links/${id}`, { method: 'DELETE' });
        cargarLinktreeConfig();
    } catch (e) {
        alert("Error al eliminar enlace");
    }
}

// ------------------------------------------------------------------------------
// 7. TAB 5 & 6: CONOCIMIENTO IA, HORARIOS Y AJUSTES
// ------------------------------------------------------------------------------
async function cargarConfiguracion() {
    try {
        const config = await apiFetch('/api/configuracion');
        if (document.getElementById('config-modelo-ia')) document.getElementById('config-modelo-ia').value = config.gemini_modelo_ia || 'gemini-3.6-flash';
        if (document.getElementById('config-estilo-longitud-ia')) document.getElementById('config-estilo-longitud-ia').value = config.estilo_longitud_ia || 'breve';
        if (document.getElementById('config-mostrar-menu-numerico')) document.getElementById('config-mostrar-menu-numerico').checked = config.mostrar_menu_numerico !== '0';
        if (document.getElementById('config-api-key')) document.getElementById('config-api-key').value = config.gemini_api_key || '';
        if (document.getElementById('config-prompt-ia')) document.getElementById('config-prompt-ia').value = config.prompt_ia || '';
        if (document.getElementById('config-catalogo-servicios')) document.getElementById('config-catalogo-servicios').value = config.catalogo_servicios || '';
        if (document.getElementById('config-ubicacion-direccion')) document.getElementById('config-ubicacion-direccion').value = config.ubicacion_direccion || '';
        if (document.getElementById('config-ubicacion-maps')) document.getElementById('config-ubicacion-maps').value = config.ubicacion_maps_link || '';
        if (document.getElementById('config-datos-bancarios')) document.getElementById('config-datos-bancarios').value = config.datos_bancarios || '';
        
        if (document.getElementById('config-nombre-negocio')) document.getElementById('config-nombre-negocio').value = config.nombre_negocio || '';
        if (document.getElementById('config-icono-asistente')) document.getElementById('config-icono-asistente').value = config.icono_asistente || '🤖';
        if (document.getElementById('config-enlace-privacidad')) document.getElementById('config-enlace-privacidad').value = config.enlace_formulario_privacidad || 'https://forms.gle/zJxZeXXj1TwWGF9N8';
        if (document.getElementById('config-numeros-admin')) document.getElementById('config-numeros-admin').value = config.numeros_admins || '';
        if (document.getElementById('config-grupo-control')) document.getElementById('config-grupo-control').value = config.grupo_control || '[CONTROL-BOT]';
        if (document.getElementById('config-tiempo-pausa')) document.getElementById('config-tiempo-pausa').value = config.tiempo_pausa_humano_mins || '30';

        if (document.getElementById('config-google-sheets-url')) document.getElementById('config-google-sheets-url').value = config.google_sheets_url || '';
        if (document.getElementById('config-duracion-cita')) document.getElementById('config-duracion-cita').value = config.duracion_cita_mins || '30';
        if (document.getElementById('config-google-calendar-link')) document.getElementById('config-google-calendar-link').value = config.google_calendar_link || '';

        if (document.getElementById('config-horario-fisico')) document.getElementById('config-horario-fisico').value = config.horario_sucursal_fisica || '';
        if (document.getElementById('config-horario-online')) document.getElementById('config-horario-online').value = config.horario_asesor_en_linea || '';
        if (document.getElementById('config-hora-inicio-semana')) document.getElementById('config-hora-inicio-semana').value = config.hora_inicio_semana || '14:00';
        if (document.getElementById('config-hora-fin-semana')) document.getElementById('config-hora-fin-semana').value = config.hora_fin_semana || '20:30';
        if (document.getElementById('config-mensaje-fuera-horario')) document.getElementById('config-mensaje-fuera-horario').value = config.mensaje_fuera_horario || '';

        const esDiferente = config.horario_online_diferente === '1' || (config.horario_asesor_en_linea && config.horario_sucursal_fisica && config.horario_asesor_en_linea !== config.horario_sucursal_fisica);
        const toggleOnline = document.getElementById('toggle-horario-online-diferente');
        if (toggleOnline) {
            toggleOnline.checked = !!esDiferente;
            toggleHorarioOnlineVisible(toggleOnline.checked);
        }

        // Cargar Rejilla Semanal de 7 Días
        const dias = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'];
        if (config.horarios_semanales_json) {
            try {
                const sObj = JSON.parse(config.horarios_semanales_json);
                dias.forEach(d => {
                    if (sObj[d]) {
                        const s = sObj[d];
                        if (document.getElementById(`chk-dia-${d}`)) document.getElementById(`chk-dia-${d}`).checked = !!s.abierto;
                        if (document.getElementById(`dia-${d}-t1-inicio`)) document.getElementById(`dia-${d}-t1-inicio`).value = s.t1Inicio || '08:00';
                        if (document.getElementById(`dia-${d}-t1-fin`)) document.getElementById(`dia-${d}-t1-fin`).value = s.t1Fin || '14:00';
                        if (document.getElementById(`chk-dia-${d}-t2`)) document.getElementById(`chk-dia-${d}-t2`).checked = !!s.t2Activo;
                        if (document.getElementById(`dia-${d}-t2-inicio`)) document.getElementById(`dia-${d}-t2-inicio`).value = s.t2Inicio || '16:00';
                        if (document.getElementById(`dia-${d}-t2-fin`)) document.getElementById(`dia-${d}-t2-fin`).value = s.t2Fin || '18:00';
                    }
                });
            } catch(e) {}
        }

        if (document.getElementById('config-ausencia-activa')) document.getElementById('config-ausencia-activa').checked = (config.ausencia_activa === '1');
        if (document.getElementById('config-ausencia-mensaje')) document.getElementById('config-ausencia-mensaje').value = config.ausencia_mensaje || '';
        if (document.getElementById('config-ausencia-fecha')) document.getElementById('config-ausencia-fecha').value = config.ausencia_fecha_fin || '';

        if (document.getElementById('config-modo-prueba')) document.getElementById('config-modo-prueba').checked = (config.modo_prueba_admins === '1');
        if (document.getElementById('config-notificar-admins-activa')) document.getElementById('config-notificar-admins-activa').checked = (config.notificar_admins_activa === '1');
        if (document.getElementById('config-palabras-clave-alerta')) document.getElementById('config-palabras-clave-alerta').value = config.palabras_clave_alerta || '';
        if (document.getElementById('config-destino-alerta-admins')) document.getElementById('config-destino-alerta-admins').value = config.destino_alerta_admins || 'ambos';

        cargarMenuNumerico(config.menu_numerico);
        cargarListaIgnorados();
        cargarDocumentosConocimiento();
        cargarInfografiasImagenes();
    } catch (e) {
        console.error("Error al cargar config:", e);
    }
}

// ------------------------------------------------------------------------------
// GESTOR DE MENÚ NUMÉRICO INTERACTIVO (1, 2, 3...)
// ------------------------------------------------------------------------------
let menuNumericoActual = [];

function cargarMenuNumerico(menuRaw) {
    try {
        if (typeof menuRaw === 'string') {
            menuNumericoActual = JSON.parse(menuRaw);
        } else if (Array.isArray(menuRaw)) {
            menuNumericoActual = menuRaw;
        } else {
            menuNumericoActual = [];
        }
    } catch (e) {
        menuNumericoActual = [];
    }
    renderizarMenuNumerico();
}

function renderizarMenuNumerico() {
    const cont = document.getElementById('lista-menu-numerico-container');
    if (!cont) return;
    cont.innerHTML = '';

    if (menuNumericoActual.length === 0) {
        cont.innerHTML = '<div class="p-4 bg-slate-950 border border-slate-800 rounded-2xl text-xs text-slate-500 text-center">No hay opciones configuradas. Haz clic en "+ Nueva Opción" para agregar respuestas automáticas con números (1, 2, 3...).</div>';
        return;
    }

    menuNumericoActual.forEach((item, index) => {
        const div = document.createElement('div');
        div.className = "p-4 bg-slate-950 border border-slate-800 rounded-2xl flex items-start justify-between space-x-4";
        div.innerHTML = `
            <div class="flex items-start space-x-3">
                <span class="w-7 h-7 bg-amber-500/20 text-amber-400 font-bold font-mono rounded-xl flex items-center justify-center flex-shrink-0 text-sm border border-amber-500/30">
                    ${item.opcion}
                </span>
                <div class="space-y-1">
                    <div class="text-sm font-bold text-white flex items-center space-x-2">
                        <span>${item.titulo}</span>
                        ${item.enlace ? `<a href="${item.enlace}" target="_blank" class="text-xs text-indigo-400 hover:underline"><i class="fa-solid fa-arrow-up-right-from-square"></i></a>` : ''}
                    </div>
                    <p class="text-xs text-slate-400 whitespace-pre-wrap leading-relaxed">${item.respuesta}</p>
                    ${item.enlace ? `<div class="text-[11px] text-indigo-400 truncate">🔗 ${item.enlace}</div>` : ''}
                </div>
            </div>
            <div class="flex items-center space-x-2 flex-shrink-0">
                <button onclick="editarOpcionMenu(${index})" class="text-slate-400 hover:text-amber-400 transition text-xs p-1.5 bg-slate-900 rounded-lg">
                    <i class="fa-solid fa-pen"></i>
                </button>
                <button onclick="eliminarOpcionMenu(${index})" class="text-slate-400 hover:text-rose-400 transition text-xs p-1.5 bg-slate-900 rounded-lg">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </div>
        `;
        cont.appendChild(div);
    });
}

let indiceEdicionMenu = -1;

function abrirModalNuevaOpcionMenu(index = -1) {
    indiceEdicionMenu = index;
    if (index >= 0 && menuNumericoActual[index]) {
        const item = menuNumericoActual[index];
        document.getElementById('menu-num-digito').value = item.opcion;
        document.getElementById('menu-num-titulo').value = item.titulo;
        document.getElementById('menu-num-respuesta').value = item.respuesta;
        document.getElementById('menu-num-enlace').value = item.enlace || '';
    } else {
        document.getElementById('menu-num-digito').value = (menuNumericoActual.length + 1).toString();
        document.getElementById('menu-num-titulo').value = '';
        document.getElementById('menu-num-respuesta').value = '';
        document.getElementById('menu-num-enlace').value = '';
    }
    document.getElementById('modal-menu-numerico').classList.remove('hidden');
}

function editarOpcionMenu(index) {
    abrirModalNuevaOpcionMenu(index);
}

function cerrarModalMenuNumerico() {
    document.getElementById('modal-menu-numerico').classList.add('hidden');
}

async function guardarOpcionMenu(e) {
    e.preventDefault();
    const opcion = document.getElementById('menu-num-digito').value.trim();
    const titulo = document.getElementById('menu-num-titulo').value.trim();
    const respuesta = document.getElementById('menu-num-respuesta').value.trim();
    const enlace = document.getElementById('menu-num-enlace').value.trim();

    const nuevoItem = { opcion, titulo, respuesta, enlace };

    if (indiceEdicionMenu >= 0) {
        menuNumericoActual[indiceEdicionMenu] = nuevoItem;
    } else {
        menuNumericoActual.push(nuevoItem);
    }

    cerrarModalMenuNumerico();
    renderizarMenuNumerico();

    try {
        await apiFetch('/api/configuracion', {
            method: 'POST',
            body: JSON.stringify({
                menu_numerico: JSON.stringify(menuNumericoActual)
            })
        });
        alert("✅ Opción del menú guardada con éxito.");
    } catch (err) {
        alert("Error al guardar menú: " + err.message);
    }
}

async function eliminarOpcionMenu(index) {
    if (!confirm("¿Eliminar esta opción del menú?")) return;
    menuNumericoActual.splice(index, 1);
    renderizarMenuNumerico();

    try {
        await apiFetch('/api/configuracion', {
            method: 'POST',
            body: JSON.stringify({
                menu_numerico: JSON.stringify(menuNumericoActual)
            })
        });
    } catch (err) {
        alert("Error al eliminar opción: " + err.message);
    }
}

// Auto-detectar modelos vigentes de Google Gemini
async function detectarModelosEnVivo() {
    const icono = document.getElementById('icono-sync-modelos');
    if (icono) icono.classList.add('fa-spin');
    const select = document.getElementById('config-modelo-ia');
    const valActual = select ? select.value : 'gemini-3.6-flash';

    try {
        const data = await apiFetch('/api/gemini/modelos');
        if (data.success && data.modelos && data.modelos.length > 0) {
            select.innerHTML = '';
            data.modelos.forEach(mod => {
                const opt = document.createElement('option');
                opt.value = mod;
                if (mod.includes('flash')) {
                    opt.textContent = `${mod} ⚡ (Flash - Bajo Costo y Alta Velocidad)`;
                } else if (mod.includes('pro')) {
                    opt.textContent = `${mod} 🧠 (Pro - Razonamiento Profundo)`;
                } else {
                    opt.textContent = mod;
                }
                select.appendChild(opt);
            });
            if (data.modelos.includes(valActual)) {
                select.value = valActual;
            } else {
                select.value = data.modelos[0];
            }
            alert(`✅ Se detectaron ${data.modelos.length} modelos oficiales activos en tu cuenta de Google AI Studio.`);
        }
    } catch (e) {
        alert("No se pudieron consultar los modelos en vivo: " + e.message);
    } finally {
        if (icono) icono.classList.remove('fa-spin');
    }
}

// Alternar ver / ocultar clave API
function toggleMostrarApiKey() {
    const input = document.getElementById('config-api-key');
    const icono = document.getElementById('icono-ojo-api');
    if (!input) return;
    if (input.type === 'password') {
        input.type = 'text';
        if (icono) icono.className = 'fa-solid fa-eye-slash';
    } else {
        input.type = 'password';
        if (icono) icono.className = 'fa-solid fa-eye';
    }
}

// Guardar Todo el Conocimiento de IA, Catálogo y Clave API
async function guardarConocimientoIA() {
    try {
        const apiKey = document.getElementById('config-api-key') ? document.getElementById('config-api-key').value.trim() : '';
        const modeloIA = document.getElementById('config-modelo-ia') ? document.getElementById('config-modelo-ia').value : 'gemini-3.6-flash';
        const estiloLongitud = document.getElementById('config-estilo-longitud-ia') ? document.getElementById('config-estilo-longitud-ia').value : 'breve';
        const mostrarMenu = document.getElementById('config-mostrar-menu-numerico') ? (document.getElementById('config-mostrar-menu-numerico').checked ? '1' : '0') : '1';
        const promptIA = document.getElementById('config-prompt-ia') ? document.getElementById('config-prompt-ia').value : '';
        const catalogo = document.getElementById('config-catalogo-servicios') ? document.getElementById('config-catalogo-servicios').value : '';
        const googleSheets = document.getElementById('config-google-sheets-url') ? document.getElementById('config-google-sheets-url').value : '';
        const direccion = document.getElementById('config-ubicacion-direccion') ? document.getElementById('config-ubicacion-direccion').value : '';
        const maps = document.getElementById('config-ubicacion-maps') ? document.getElementById('config-ubicacion-maps').value : '';
        const bancos = document.getElementById('config-datos-bancarios') ? document.getElementById('config-datos-bancarios').value : '';

        await apiFetch('/api/configuracion', {
            method: 'POST',
            body: JSON.stringify({
                gemini_api_key: apiKey,
                gemini_modelo_ia: modeloIA,
                estilo_longitud_ia: estiloLongitud,
                mostrar_menu_numerico: mostrarMenu,
                prompt_ia: promptIA,
                catalogo_servicios: catalogo,
                google_sheets_url: googleSheets,
                ubicacion_direccion: direccion,
                ubicacion_maps_link: maps,
                datos_bancarios: bancos
            })
        });

        alert("✅ Todo el conocimiento de IA, Catálogo y Clave API guardados con éxito en la memoria del bot.");
    } catch (e) {
        alert("Error al guardar conocimiento de IA: " + e.message);
    }
}

function seleccionarIconoPreset(val) {
    const input = document.getElementById('config-icono-asistente');
    if (!input) return;
    if (val === 'custom') {
        input.value = '';
        input.focus();
    } else {
        input.value = val;
    }
}

// Guardar Identidad del Negocio y Administradores
async function guardarIdentidadNegocio() {
    try {
        await apiFetch('/api/configuracion', {
            method: 'POST',
            body: JSON.stringify({
                nombre_negocio: document.getElementById('config-nombre-negocio').value,
                icono_asistente: document.getElementById('config-icono-asistente').value,
                enlace_formulario_privacidad: document.getElementById('config-enlace-privacidad').value,
                numeros_admins: document.getElementById('config-numeros-admin').value,
                grupo_control: document.getElementById('config-grupo-control').value,
                tiempo_pausa_humano_mins: document.getElementById('config-tiempo-pausa').value,
                modo_prueba_admins: document.getElementById('config-modo-prueba').checked ? '1' : '0',
                notificar_admins_activa: document.getElementById('config-notificar-admins-activa').checked ? '1' : '0',
                palabras_clave_alerta: document.getElementById('config-palabras-clave-alerta').value,
                destino_alerta_admins: document.getElementById('config-destino-alerta-admins').value
            })
        });
        alert("✅ Identidad del negocio y ajustes guardados con éxito.");
    } catch (e) {
        alert("Error al guardar: " + e.message);
    }
}

function aplicarPlantillaHorario(texto) {
    const txtArea = document.getElementById('config-horario-fisico');
    if (txtArea) {
        txtArea.value = texto;
        txtArea.focus();
    }
}

function toggleHorarioOnlineVisible(visible) {
    const sec = document.getElementById('seccion-horario-online');
    if (sec) {
        if (visible) sec.classList.remove('hidden');
        else sec.classList.add('hidden');
    }
}

// Guardar Horarios de Atención del Negocio (Físico y Asesores en Línea)
async function guardarHorariosDetallados() {
    try {
        const horarioFisico = document.getElementById('config-horario-fisico').value;
        const esDiferente = document.getElementById('toggle-horario-online-diferente') ? document.getElementById('toggle-horario-online-diferente').checked : false;
        const horarioOnline = esDiferente ? (document.getElementById('config-horario-online').value || horarioFisico) : horarioFisico;
        const horaInicio = document.getElementById('config-hora-inicio-semana') ? document.getElementById('config-hora-inicio-semana').value : '14:00';
        const horaFin = document.getElementById('config-hora-fin-semana') ? document.getElementById('config-hora-fin-semana').value : '20:30';
        const msgFuera = document.getElementById('config-mensaje-fuera-horario').value;

        await apiFetch('/api/configuracion', {
            method: 'POST',
            body: JSON.stringify({
                horario_sucursal_fisica: horarioFisico,
                horario_asesor_en_linea: horarioOnline,
                horario_online_diferente: esDiferente ? '1' : '0',
                hora_inicio_semana: horaInicio,
                hora_fin_semana: horaFin,
                mensaje_fuera_horario: msgFuera
            })
        });
        alert("✅ Horarios de atención guardados con éxito.");
    } catch (e) {
        alert("Error al guardar horarios: " + e.message);
    }
}

// Guardar Modo Ausencia desde la pestaña de Configuración
async function guardarModoAusenciaTab() {
    try {
        const activa = document.getElementById('config-ausencia-activa').checked;
        const mensaje = document.getElementById('config-ausencia-mensaje').value;
        const fecha_fin = document.getElementById('config-ausencia-fecha').value;

        await apiFetch('/api/bot/ausencia', {
            method: 'POST',
            body: JSON.stringify({ activa, mensaje, fecha_fin })
        });
        alert("✅ Estado de vacaciones/ausencia guardado con éxito.");
        cargarEstadoControlBot();
    } catch (e) {
        alert("Error al guardar: " + e.message);
    }
}

async function cargarListaIgnorados() {
    const cont = document.getElementById('lista-ignorados-container');
    if (!cont) return;

    try {
        const contactos = await apiFetch('/api/conversaciones');
        const ignorados = (contactos || []).filter(c => c.es_ignorado === 1);
        cont.innerHTML = '';

        if (ignorados.length === 0) {
            cont.innerHTML = '<div class="text-xs text-slate-500 py-2">No hay contactos ignorados registrados actualmente.</div>';
            return;
        }

        ignorados.forEach(c => {
            const div = document.createElement('div');
            div.className = "flex items-center justify-between p-3 bg-slate-950 border border-slate-800 rounded-xl text-xs";
            div.innerHTML = `
                <div class="flex items-center space-x-2.5">
                    <i class="fa-solid fa-user-slash text-slate-500"></i>
                    <span class="font-bold text-white">${c.nombre || c.pushname || c.telefono}</span>
                    <span class="text-slate-400">(${c.telefono})</span>
                </div>
                <button onclick="removerIgnorado('${c.jid}')" class="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-[11px] font-semibold transition">
                    Reactivar
                </button>
            `;
            cont.appendChild(div);
        });
    } catch (e) {
        console.error("Error cargando ignorados:", e);
    }
}

async function agregarNumeroIgnorado() {
    const input = document.getElementById('nuevo-ignorado-input');
    const num = input.value.trim().replace(/[^0-9]/g, '');
    if (!num) return alert("Ingresa un número válido");

    const jid = `${num}@c.us`;
    try {
        await apiFetch('/api/configuracion/ignorar', {
            method: 'POST',
            body: JSON.stringify({ jid, telefono: num, es_ignorado: 1 })
        });
        input.value = '';
        cargarListaIgnorados();
        alert(`Contacto ${num} agregado a la lista de ignorados.`);
    } catch (e) {
        alert("Error: " + e.message);
    }
}

async function removerIgnorado(jid) {
    try {
        await apiFetch('/api/configuracion/ignorar', {
            method: 'POST',
            body: JSON.stringify({ jid, es_ignorado: 0 })
        });
        cargarListaIgnorados();
    } catch (e) {
        alert("Error al reactivar contacto: " + e.message);
    }
}

function descargarRespaldoBD() {
    window.location.href = `/api/backup/descargar?token=${token}`;
}

// ------------------------------------------------------------------------------
// 8. MODAL QR Y WEBSOCKETS EN TIEMPO REAL
// ------------------------------------------------------------------------------
function abrirModalQR() {
    document.getElementById('modal-qr').classList.remove('hidden');
}

function cerrarModalQR() {
    document.getElementById('modal-qr').classList.add('hidden');
}

function actualizarBadgeWhatsApp(conectado) {
    const badge = document.getElementById('btn-estado-whatsapp');
    const txt = document.getElementById('texto-estado-whatsapp');

    if (conectado) {
        badge.className = "cursor-pointer flex items-center space-x-2 px-3.5 py-1.5 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 rounded-full text-xs font-semibold hover:bg-emerald-500/20 transition";
        txt.textContent = "Conectado";
    } else {
        badge.className = "cursor-pointer flex items-center space-x-2 px-3.5 py-1.5 bg-rose-500/10 border border-rose-500/20 text-rose-400 rounded-full text-xs font-semibold hover:bg-rose-500/20 transition animate-pulse";
        txt.textContent = "Desconectado (Escanear QR)";
    }
}

socket.on('qr_actualizado', ({ qr }) => {
    actualizarBadgeWhatsApp(false);
    const cont = document.getElementById('qr-container');
    cont.innerHTML = '';
    const canvas = document.createElement('canvas');
    QRCode.toCanvas(canvas, qr, { width: 200 }, (err) => {
        if (!err) cont.appendChild(canvas);
    });
});

socket.on('estado_whatsapp', ({ conectado }) => {
    actualizarBadgeWhatsApp(conectado);
    if (conectado) cerrarModalQR();
    cargarEstadoControlBot();
});

socket.on('nuevo_mensaje', (msg) => {
    if (currentTab === 'conversaciones') {
        cargarListaConversaciones();
        if (chatActivoJid) {
            const numActivo = chatActivoJid.replace(/[^0-9]/g, '');
            const numMsg = (msg.chat_id || '').replace(/[^0-9]/g, '');
            if (chatActivoJid === msg.chat_id || (numActivo && numMsg && (numActivo.includes(numMsg) || numMsg.includes(numActivo)))) {
                seleccionarChat(chatActivoJid, document.getElementById('chat-nombre-cliente').textContent);
            }
        }
    } else {
        const badge = document.getElementById('badge-mensajes-nuevos');
        if (badge) badge.classList.remove('hidden');
    }
});

socket.on('solicitud_asesor_actualizada', async () => {
    await cargarSolicitudesAsesor();
    aplicarFiltrosConversaciones();
});

// ==============================================================================
// 10. MODAL DE INSTRUCTIVOS DINÁMICOS
// ==============================================================================
const INSTRUCTIVOS = {
    'gemini-api-key': {
        titulo: 'Cómo obtener tu API Key de Google Gemini (100% Gratis)',
        subtitulo: 'Genera tu clave de Inteligencia Artificial en 1 minuto sin costo',
        icono: '<i class="fa-solid fa-key text-indigo-400"></i>',
        enlace: 'https://aistudio.google.com/app/apikey',
        btnTexto: 'Abrir Google AI Studio',
        pasos: [
            '1. Haz clic en el botón inferior para abrir <b>Google AI Studio</b> e inicia sesión con tu cuenta de Gmail.',
            '2. Presiona el botón azul <b>"Get API Key"</b> o <b>"Create API key"</b>.',
            '3. Selecciona <b>"Create API key in new project"</b>.',
            '4. Copia tu clave generada (es un código largo que empieza con <code>AIzaSy...</code>).',
            '5. Pégala en el campo <b>"Tu Clave de IA"</b> en este panel y haz clic en Guardar.'
        ]
    },
    'google-sheets': {
        titulo: 'Cómo conectar tu Inventario en Vivo de Google Sheets',
        subtitulo: 'La IA consultará tus precios y existencias en tiempo real',
        icono: '<i class="fa-solid fa-table-cells text-emerald-400"></i>',
        enlace: 'https://sheets.google.com',
        btnTexto: 'Abrir Google Sheets',
        pasos: [
            '1. Abre <b>Google Sheets</b> y crea una hoja de cálculo con columnas claras (ej: <code>Producto | Talla/Tipo | Precio | Stock/Existencia</code>).',
            '2. En la esquina superior derecha, haz clic en el botón verde <b>"Compartir"</b>.',
            '3. En la sección <i>Acceso general</i>, cambia la opción de <i>Restringido</i> a <b>"Cualquier persona con el enlace"</b> (con permiso de <b>Lector</b>).',
            '4. Haz clic en <b>"Copiar enlace"</b>.',
            '5. Pega ese enlace en el campo de Google Sheets en este panel y presiona Guardar. ¡Cada cambio que hagas en tu hoja se reflejará al instante en WhatsApp!'
        ]
    },
    'google-calendar': {
        titulo: 'Cómo sincronizar tu Agenda con Google Calendar',
        subtitulo: 'Permite que tus clientes agreguen sus citas a su calendario de Google',
        icono: '<i class="fa-solid fa-calendar-days text-indigo-400"></i>',
        enlace: 'https://calendar.google.com',
        btnTexto: 'Abrir Google Calendar',
        pasos: [
            '1. Abre <b>Google Calendar</b> en tu navegador.',
            '2. Ve al icono de engranaje ⚙️ arriba a la derecha y entra a <b>"Configuración"</b>.',
            '3. En la barra izquierda, haz clic en tu calendario principal y busca la sección <b>"Integrar el calendario"</b>.',
            '4. Copia la <b>"Dirección pública en formato iCal"</b> o el enlace público para compartir.',
            '5. Pégalo aquí en el panel. <i>(Nota: Si utilizas plataformas como Cal.com o Calendly, también puedes pegar tu enlace directo de agendamiento)</i>.'
        ]
    },
    'linktree-instagram': {
        titulo: 'Cómo colocar tu Página de Enlaces en Instagram y TikTok',
        subtitulo: 'Haz que tus seguidores de redes sociales entren directo a tu WhatsApp',
        icono: '<i class="fa-brands fa-instagram text-pink-400"></i>',
        enlace: 'https://instagram.com',
        btnTexto: 'Ir a Instagram',
        pasos: [
            '1. En la pestaña <b>"Página de Enlaces"</b> de este panel, presiona el botón verde <b>"Copiar Enlace para Instagram"</b>.',
            '2. Abre la app de <b>Instagram</b> en tu teléfono celular.',
            '3. Ve a tu perfil y toca el botón <b>"Editar perfil"</b>.',
            '4. Toca en <b>"Enlaces"</b> > <b>"Agregar enlace externo"</b>.',
            '5. Pega la URL en el campo URL y en Título escribe <b>"WhatsApp y Citas Oficiales"</b>.',
            '6. Guarda los cambios. ¡Tus seguidores ahora verán tu botón oficial en su biografía!'
        ]
    },
    'archivos-catalogo': {
        titulo: 'Guía de Documentos de Catálogo y Precios',
        subtitulo: 'Formatos recomendados para nutrir la memoria de la IA',
        icono: '<i class="fa-solid fa-file-pdf text-rose-400"></i>',
        enlace: '#',
        btnTexto: 'Entendido',
        pasos: [
            '• <b>Archivos Excel / CSV (.csv, .xlsx):</b> Ideales para listas de precios con cientos de productos, tallas, variantes y códigos.',
            '• <b>Archivos PDF (.pdf):</b> Ideales para folletos visuales, catálogos de temporada, políticas de garantía y procedimientos.',
            '• <b>Archivos de Texto (.txt, .md):</b> Ideales para preguntas frecuentes (FAQ) y respuestas a objeciones comunes de clientes.',
            '• <b>Recomendación:</b> Mantén los precios claros con signo de pesos (ej: <code>$450 MXN</code>) para que la IA nunca cometa errores al cotizar.'
        ]
    }
};

function abrirInstructivo(tipo) {
    const inst = INSTRUCTIVOS[tipo];
    if (!inst) return;

    document.getElementById('inst-icono').innerHTML = inst.icono;
    document.getElementById('inst-titulo').textContent = inst.titulo;
    document.getElementById('inst-subtitulo').textContent = inst.subtitulo;
    document.getElementById('inst-btn-enlace').href = inst.enlace;
    document.getElementById('inst-btn-texto').textContent = inst.btnTexto;

    if (inst.enlace === '#') {
        document.getElementById('inst-btn-enlace').classList.add('hidden');
    } else {
        document.getElementById('inst-btn-enlace').classList.remove('hidden');
    }

    const cont = document.getElementById('inst-pasos');
    cont.innerHTML = inst.pasos.map(p => `<div class="p-2.5 bg-slate-900/80 rounded-xl border border-slate-800/60">${p}</div>`).join('');

    document.getElementById('modal-instructivo').classList.remove('hidden');
}

function cerrarInstructivo() {
    document.getElementById('modal-instructivo').classList.add('hidden');
}

// ------------------------------------------------------------------------------
// 8. CONTROL RÁPIDO DEL BOT (1 CLIC), AUSENCIA E IGNORADOS
// ------------------------------------------------------------------------------
async function cargarEstadoControlBot() {
    try {
        const data = await apiFetch('/api/bot/estado-control');
        actualizarUIEstadoControl(data);
    } catch (e) {
        console.error("Error al cargar estado de control del bot:", e);
    }
}

function actualizarUIEstadoControl(data) {
    const indicator = document.getElementById('bot-status-indicator');
    const statusText = document.getElementById('bot-status-text');
    const statusBadge = document.getElementById('bot-status-badge');
    const statusSub = document.getElementById('bot-status-sub');
    const countBadge = document.getElementById('count-ignorados-badge');

    if (countBadge && data.ignoradosCount !== undefined) {
        countBadge.textContent = data.ignoradosCount;
    }

    if (!data.wsClienteConectado) {
        if (indicator) indicator.className = "w-3.5 h-3.5 rounded-full bg-amber-500 animate-pulse";
        if (statusText) statusText.textContent = "WhatsApp Desconectado (Escanea QR)";
        if (statusBadge) {
            statusBadge.className = "px-2 py-0.5 text-[10px] font-bold bg-amber-500/10 text-amber-400 border border-amber-500/20 rounded-full";
            statusBadge.textContent = "Desconectado";
        }
        if (statusSub) statusSub.textContent = "Haz clic en 'Desconectado' arriba para vincular tu WhatsApp";
        return;
    }

    if (data.botPausadoGlobal) {
        if (indicator) indicator.className = "w-3.5 h-3.5 rounded-full bg-rose-500";
        if (statusText) statusText.textContent = "Bot Pausado Globalmente";
        if (statusBadge) {
            statusBadge.className = "px-2 py-0.5 text-[10px] font-bold bg-rose-500/10 text-rose-400 border border-rose-500/20 rounded-full";
            statusBadge.textContent = "Pausado";
        }
        if (statusSub) statusSub.textContent = "El bot no está respondiendo a clientes. Haz clic en 'Reactivar Bot' para reanudar";
        return;
    }

    if (data.ausenciaActiva) {
        const programadoTag = data.esProgramado ? ' (Auto Calendario)' : '';
        if (data.ausenciaTipo === 'festivo') {
            if (indicator) indicator.className = "w-3.5 h-3.5 rounded-full bg-emerald-500 animate-pulse";
            if (statusText) statusText.textContent = `Día Festivo Oficial / Inhábil${programadoTag}`;
            if (statusBadge) {
                statusBadge.className = "px-2.5 py-0.5 text-[10px] font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 rounded-full";
                statusBadge.textContent = "🇲🇽 Día Festivo";
            }
            if (statusSub) statusSub.textContent = `Asueto oficial: "${data.ausenciaMsg || 'Día Festivo Oficial'}" (Reanudación: ${data.ausenciaFecha || 'Próximamente'}). IA atendiendo dudas 24/7.`;
        } else if (data.ausenciaTipo === 'curso') {
            if (indicator) indicator.className = "w-3.5 h-3.5 rounded-full bg-indigo-500 animate-pulse";
            if (statusText) statusText.textContent = `Personal en Capacitación / Congreso Médico${programadoTag}`;
            if (statusBadge) {
                statusBadge.className = "px-2.5 py-0.5 text-[10px] font-bold bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 rounded-full";
                statusBadge.textContent = "🎓 Modo Curso";
            }
            if (statusSub) statusSub.textContent = `Aviso activo: "${data.ausenciaMsg || 'Capacitación Médica Continua'}" (Reanudación: ${data.ausenciaFecha || 'Próximamente'}). IA atendiendo dudas 24/7.`;
        } else {
            if (indicator) indicator.className = "w-3.5 h-3.5 rounded-full bg-sky-500 animate-pulse";
            if (statusText) statusText.textContent = `Modo Ausencia / Vacaciones Activo${programadoTag}`;
            if (statusBadge) {
                statusBadge.className = "px-2 py-0.5 text-[10px] font-bold bg-sky-500/10 text-sky-400 border border-sky-500/20 rounded-full";
                statusBadge.textContent = "🏖️ Vacaciones";
            }
            if (statusSub) statusSub.textContent = `Aviso activo: "${data.ausenciaMsg || 'En periodo de descanso'}" (Reanudación: ${data.ausenciaFecha || 'Próximamente'}).`;
        }
        return;
    }

    // Activo Normal
    if (indicator) indicator.className = "w-3.5 h-3.5 rounded-full bg-emerald-500 animate-pulse";
    if (statusText) statusText.textContent = "Bot en Línea (Atendiendo 24/7)";
    if (statusBadge) {
        statusBadge.className = "px-2 py-0.5 text-[10px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded-full";
        statusBadge.textContent = "Activo";
    }
    if (statusSub) statusSub.textContent = `Respuestas con IA activas (${data.chatsPausadosCount || 0} pausas temporales)`;
}

async function ejecutarReactivarBot() {
    try {
        const res = await apiFetch('/api/bot/reactivar', { method: 'POST' });
        alert("✅ " + (res.mensaje || "Bot reactivado exitosamente. Se han reanudado todas las conversaciones."));
        cargarEstadoControlBot();
    } catch (e) {
        alert("Error al reactivar bot: " + e.message);
    }
}

async function ejecutarPausarBot() {
    if (!confirm("¿Deseas pausar el bot globalmente? No responderá automáticamente a ningún cliente hasta que lo reactives.")) return;
    try {
        const res = await apiFetch('/api/bot/pausar', { method: 'POST' });
        alert("⏸️ " + (res.mensaje || "Bot pausado globalmente."));
        cargarEstadoControlBot();
    } catch (e) {
        alert("Error al pausar bot: " + e.message);
    }
}

function abrirModalAusencia(tipoPreseleccionado = null, vistaInicial = 'inmediato') {
    cambiarVistaModalAusencia(vistaInicial);
    apiFetch('/api/bot/estado-control').then(data => {
        const tipoFinal = tipoPreseleccionado || data.ausenciaTipo || 'curso';
        seleccionarTipoModalAusencia(tipoFinal);
        const switchActiva = document.getElementById('modal-ausencia-activa');
        if (switchActiva) switchActiva.checked = !!data.ausenciaActiva;
        const inputMsg = document.getElementById('modal-ausencia-mensaje');
        if (inputMsg && data.ausenciaMsg) inputMsg.value = data.ausenciaMsg;
        const inputFecha = document.getElementById('modal-ausencia-fecha');
        if (inputFecha && data.ausenciaFecha) inputFecha.value = data.ausenciaFecha;
        document.getElementById('modal-ausencia').classList.remove('hidden');
    }).catch(() => {
        seleccionarTipoModalAusencia(tipoPreseleccionado || 'curso');
        document.getElementById('modal-ausencia').classList.remove('hidden');
    });

    if (vistaInicial === 'calendario') {
        cargarListaEventosAusencia();
    }
}

function cambiarVistaModalAusencia(vista) {
    const secInmediato = document.getElementById('seccion-modal-inmediato');
    const secCalendario = document.getElementById('seccion-modal-calendario');
    const btnInmediato = document.getElementById('btn-vista-inmediato');
    const btnCalendario = document.getElementById('btn-vista-calendario');

    if (vista === 'calendario') {
        if (secInmediato) secInmediato.classList.add('hidden');
        if (secCalendario) secCalendario.classList.remove('hidden');
        if (btnCalendario) btnCalendario.className = "py-2 px-3 rounded-xl text-xs font-bold transition flex items-center justify-center space-x-2 bg-indigo-600/30 text-indigo-300 border border-indigo-500/30";
        if (btnInmediato) btnInmediato.className = "py-2 px-3 rounded-xl text-xs font-bold transition flex items-center justify-center space-x-2 text-slate-400 hover:text-white border border-transparent";
        cargarListaEventosAusencia();
    } else {
        if (secInmediato) secInmediato.classList.remove('hidden');
        if (secCalendario) secCalendario.classList.add('hidden');
        if (btnInmediato) btnInmediato.className = "py-2 px-3 rounded-xl text-xs font-bold transition flex items-center justify-center space-x-2 bg-indigo-600/30 text-indigo-300 border border-indigo-500/30";
        if (btnCalendario) btnCalendario.className = "py-2 px-3 rounded-xl text-xs font-bold transition flex items-center justify-center space-x-2 text-slate-400 hover:text-white border border-transparent";
    }
}

function seleccionarTipoModalAusencia(tipo) {
    const tipoInput = document.getElementById('modal-ausencia-tipo');
    if (tipoInput) tipoInput.value = tipo;

    const btnCur = document.getElementById('btn-tab-modal-curso');
    const btnFes = document.getElementById('btn-tab-modal-festivo');
    const btnVac = document.getElementById('btn-tab-modal-vacaciones');
    const iconoDiv = document.getElementById('modal-ausencia-icono');
    const iconoI = document.getElementById('modal-ausencia-icono-i');
    const tituloModal = document.getElementById('modal-ausencia-titulo');
    const labelSwitch = document.getElementById('label-switch-ausencia');
    const subSwitch = document.getElementById('sub-switch-ausencia');
    const toggleBg = document.getElementById('toggle-bg-ausencia');
    const labelMotivo = document.getElementById('label-modal-ausencia-motivo');
    const textareaMotivo = document.getElementById('modal-ausencia-mensaje');
    const chipsCur = document.getElementById('chips-sugerencias-curso');
    const chipsFes = document.getElementById('chips-sugerencias-festivo');
    const chipsVac = document.getElementById('chips-sugerencias-vacaciones');
    const notaModal = document.getElementById('nota-modal-ausencia');
    const btnSubmit = document.getElementById('btn-submit-modal-ausencia');

    const btnInactivo = "py-2 px-2 rounded-xl text-xs font-bold transition flex items-center justify-center space-x-1.5 text-slate-400 hover:text-white border border-transparent";
    if (btnCur) btnCur.className = btnInactivo;
    if (btnFes) btnFes.className = btnInactivo;
    if (btnVac) btnVac.className = btnInactivo;

    if (chipsCur) chipsCur.classList.add('hidden');
    if (chipsFes) chipsFes.classList.add('hidden');
    if (chipsVac) chipsVac.classList.add('hidden');

    if (tipo === 'curso') {
        if (btnCur) btnCur.className = "py-2 px-2 rounded-xl text-xs font-bold transition flex items-center justify-center space-x-1.5 bg-indigo-600/30 text-indigo-300 border border-indigo-500/30";
        if (iconoDiv) iconoDiv.className = "w-10 h-10 rounded-xl bg-indigo-500/20 text-indigo-400 flex items-center justify-center text-lg";
        if (iconoI) iconoI.className = "fa-solid fa-graduation-cap";
        if (tituloModal) tituloModal.textContent = "Modo Curso / Capacitación Médica";
        if (labelSwitch) labelSwitch.textContent = "Activar Modo Curso";
        if (subSwitch) subSwitch.textContent = "La IA explicará la capacitación y atenderá dudas 24/7";
        if (toggleBg) toggleBg.className = "w-11 h-6 bg-slate-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-500";
        if (labelMotivo) labelMotivo.textContent = "Nombre del Curso, Taller o Congreso Médico";
        if (chipsCur) chipsCur.classList.remove('hidden');
        if (textareaMotivo && (!textareaMotivo.value || textareaMotivo.value.includes('vacacional') || textareaMotivo.value.includes('Festivo'))) {
            textareaMotivo.value = "Capacitación y Actualización Médica Continua";
        }
        if (notaModal) notaModal.innerHTML = `<span class="text-indigo-400 font-bold">🎓 Rol de la IA:</span> Explicará con calidez y prestigio médico que el equipo está en actualización continua, responderá dudas de métodos 24/7 y registrará pacientes en la <b>Lista de Espera Prioritaria</b>.`;
        if (btnSubmit) btnSubmit.className = "flex-1 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-bold shadow-md transition";
    } else if (tipo === 'festivo') {
        if (btnFes) btnFes.className = "py-2 px-2 rounded-xl text-xs font-bold transition flex items-center justify-center space-x-1.5 bg-emerald-600/30 text-emerald-300 border border-emerald-500/30";
        if (iconoDiv) iconoDiv.className = "w-10 h-10 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center text-lg";
        if (iconoI) iconoI.className = "fa-solid fa-flag text-emerald-400";
        if (tituloModal) tituloModal.textContent = "Modo Día Festivo Oficial";
        if (labelSwitch) labelSwitch.textContent = "Activar Modo Día Festivo";
        if (subSwitch) subSwitch.textContent = "Aviso institucional de asueto oficial. IA atiende dudas 24/7";
        if (toggleBg) toggleBg.className = "w-11 h-6 bg-slate-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-500";
        if (labelMotivo) labelMotivo.textContent = "Nombre del Festivo Oficial o Motivo de Asueto";
        if (chipsFes) chipsFes.classList.remove('hidden');
        if (textareaMotivo && (!textareaMotivo.value || textareaMotivo.value.includes('Capacitación') || textareaMotivo.value.includes('vacacional'))) {
            textareaMotivo.value = "Día Festivo Oficial / Inhábil";
        }
        if (notaModal) notaModal.innerHTML = `<span class="text-emerald-400 font-bold">🇲🇽 Rol de la IA:</span> Notifica con respeto institucional la suspensión de labores presenciales por día festivo, atiende consultas informativas 24/7 y registra citas en la <b>Lista de Espera Prioritaria</b> para atender a primera hora del día laboral.`;
        if (btnSubmit) btnSubmit.className = "flex-1 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-bold shadow-md transition";
    } else {
        if (btnVac) btnVac.className = "py-2 px-2 rounded-xl text-xs font-bold transition flex items-center justify-center space-x-1.5 bg-sky-600/30 text-sky-300 border border-sky-500/30";
        if (iconoDiv) iconoDiv.className = "w-10 h-10 rounded-xl bg-sky-500/20 text-sky-400 flex items-center justify-center text-lg";
        if (iconoI) iconoI.className = "fa-solid fa-umbrella-beach";
        if (tituloModal) tituloModal.textContent = "Modo Vacaciones / Receso";
        if (labelSwitch) labelSwitch.textContent = "Activar Modo Vacaciones";
        if (subSwitch) subSwitch.textContent = "El bot avisará a los clientes que el equipo está en descanso";
        if (toggleBg) toggleBg.className = "w-11 h-6 bg-slate-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-sky-500";
        if (labelMotivo) labelMotivo.textContent = "Mensaje o Motivo de Vacaciones";
        if (chipsVac) chipsVac.classList.remove('hidden');
        if (textareaMotivo && (!textareaMotivo.value || textareaMotivo.value.includes('Capacitación') || textareaMotivo.value.includes('Festivo'))) {
            textareaMotivo.value = "Periodo Vacacional de Temporada";
        }
        if (notaModal) notaModal.innerHTML = `<span class="text-sky-400 font-bold">🏖️ Rol de la IA:</span> Informará con amabilidad que el equipo está en periodo de descanso y responderá dudas generales de métodos.`;
        if (btnSubmit) btnSubmit.className = "flex-1 py-2.5 bg-sky-600 hover:bg-sky-500 text-white rounded-xl text-xs font-bold shadow-md transition";
    }
}

function setMotivoCurso(motivo) {
    const txt = document.getElementById('modal-ausencia-mensaje');
    if (txt) txt.value = motivo;
}

function setFechaRapida(opcion) {
    const inputFecha = document.getElementById('modal-ausencia-fecha');
    if (!inputFecha) return;
    const ahora = new Date();
    let fechaObj = new Date();

    if (typeof opcion === 'number') {
        fechaObj.setDate(ahora.getDate() + opcion);
    } else if (opcion === 'viernes') {
        const diaActual = ahora.getDay(); // 0 dom, 1 lun, ..., 5 vie
        let diasParaViernes = 5 - diaActual;
        if (diasParaViernes <= 0) diasParaViernes += 7;
        fechaObj.setDate(ahora.getDate() + diasParaViernes);
    } else if (opcion === 'lunes') {
        const diaActual = ahora.getDay();
        let diasParaLunes = 1 - diaActual;
        if (diasParaLunes <= 0) diasParaLunes += 7;
        fechaObj.setDate(ahora.getDate() + diasParaLunes);
    }

    const yyyy = fechaObj.getFullYear();
    const mm = String(fechaObj.getMonth() + 1).padStart(2, '0');
    const dd = String(fechaObj.getDate()).padStart(2, '0');
    inputFecha.value = `${yyyy}-${mm}-${dd}`;
}

function cerrarModalAusencia() {
    document.getElementById('modal-ausencia').classList.add('hidden');
}

async function guardarModoAusencia(e) {
    e.preventDefault();
    try {
        const activa = document.getElementById('modal-ausencia-activa').checked;
        const tipo = document.getElementById('modal-ausencia-tipo') ? document.getElementById('modal-ausencia-tipo').value : 'curso';
        const mensaje = document.getElementById('modal-ausencia-mensaje').value;
        const fecha_fin = document.getElementById('modal-ausencia-fecha').value;

        await apiFetch('/api/bot/ausencia', {
            method: 'POST',
            body: JSON.stringify({ activa, tipo, mensaje, fecha_fin })
        });

        const msjExito = tipo === 'festivo'
            ? "🇲🇽 Modo Día Festivo guardado con éxito."
            : (tipo === 'curso' ? "🎓 Modo Curso / Congreso guardado con éxito." : "🏖️ Estado de vacaciones guardado con éxito.");
        alert(msjExito);
        cerrarModalAusencia();
        cargarEstadoControlBot();
    } catch (err) {
        alert("Error al guardar modo ausencia: " + err.message);
    }
}

async function cargarListaEventosAusencia() {
    const cont = document.getElementById('lista-eventos-ausencia-container');
    if (!cont) return;
    try {
        const eventos = await apiFetch('/api/bot/eventos-ausencia');
        if (!eventos || eventos.length === 0) {
            cont.innerHTML = `<div class="p-4 text-center text-xs text-slate-500 border border-dashed border-slate-800 rounded-xl">No hay eventos ni festivos programados en el calendario. Registra uno arriba para automatizarlo.</div>`;
            return;
        }

        const hoy = new Date().toISOString().split('T')[0];

        cont.innerHTML = eventos.map(ev => {
            const esHoy = (ev.fecha_inicio <= hoy && ev.fecha_fin >= hoy);
            const esPasado = (ev.fecha_fin < hoy);
            
            let badgeTipo = `<span class="px-2 py-0.5 text-[10px] font-bold bg-emerald-500/20 text-emerald-300 rounded-md border border-emerald-500/30">🇲🇽 Festivo</span>`;
            if (ev.tipo === 'curso') badgeTipo = `<span class="px-2 py-0.5 text-[10px] font-bold bg-indigo-500/20 text-indigo-300 rounded-md border border-indigo-500/30">🎓 Curso</span>`;
            if (ev.tipo === 'vacaciones') badgeTipo = `<span class="px-2 py-0.5 text-[10px] font-bold bg-sky-500/20 text-sky-300 rounded-md border border-sky-500/30">🏖️ Vacaciones</span>`;

            let badgeEstado = `<span class="px-2 py-0.5 text-[10px] font-semibold bg-slate-800 text-slate-400 rounded-md">🗓️ Próximo</span>`;
            if (esHoy) {
                badgeEstado = `<span class="px-2 py-0.5 text-[10px] font-bold bg-emerald-500/30 text-emerald-300 border border-emerald-400/40 rounded-md animate-pulse">🟢 EN CURSO HOY (Auto)</span>`;
            } else if (esPasado) {
                badgeEstado = `<span class="px-2 py-0.5 text-[10px] font-semibold bg-slate-900 text-slate-600 rounded-md">⌛ Concluido</span>`;
            }

            const formatFecha = (fStr) => {
                if (!fStr) return '';
                const p = fStr.split('-');
                return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : fStr;
            };

            const rangoTexto = ev.fecha_inicio === ev.fecha_fin 
                ? formatFecha(ev.fecha_inicio) 
                : `${formatFecha(ev.fecha_inicio)} al ${formatFecha(ev.fecha_fin)}`;

            return `
                <div class="p-3 bg-slate-900/90 border ${esHoy ? 'border-emerald-500/40' : 'border-slate-800'} rounded-xl flex items-center justify-between space-x-3 text-xs">
                    <div class="space-y-1 min-w-0 flex-1">
                        <div class="flex items-center space-x-2">
                            ${badgeTipo}
                            ${badgeEstado}
                            <span class="text-slate-400 text-[11px] font-medium">${rangoTexto}</span>
                        </div>
                        <div class="text-white font-semibold truncate">${ev.titulo}</div>
                        ${ev.reanudacion_texto ? `<div class="text-[11px] text-slate-400 truncate">Reanuda: <span class="text-slate-300">${ev.reanudacion_texto}</span></div>` : ''}
                    </div>
                    <button type="button" onclick="eliminarEventoAusencia(${ev.id})" class="p-2 text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 rounded-lg transition" title="Eliminar evento">
                        <i class="fa-solid fa-trash-can"></i>
                    </button>
                </div>
            `;
        }).join('');
    } catch(err) {
        cont.innerHTML = `<div class="p-3 text-center text-xs text-rose-400">Error al cargar eventos: ${err.message}</div>`;
    }
}

async function guardarEventoAusencia(e) {
    e.preventDefault();
    try {
        const tipo = document.getElementById('nuevo-evento-tipo').value;
        const titulo = document.getElementById('nuevo-evento-titulo').value.trim();
        const fecha_inicio = document.getElementById('nuevo-evento-inicio').value;
        const fecha_fin = document.getElementById('nuevo-evento-fin').value;
        const reanudacion_texto = document.getElementById('nuevo-evento-reanudacion').value.trim();

        if (!titulo || !fecha_inicio || !fecha_fin) {
            alert("Por favor completa el título y las fechas de inicio y fin.");
            return;
        }

        await apiFetch('/api/bot/eventos-ausencia', {
            method: 'POST',
            body: JSON.stringify({ tipo, titulo, fecha_inicio, fecha_fin, reanudacion_texto })
        });

        alert("✅ Evento programado exitosamente. El bot lo activará y desactivará automáticamente en las fechas fijadas.");
        document.getElementById('nuevo-evento-titulo').value = '';
        document.getElementById('nuevo-evento-reanudacion').value = '';
        cargarListaEventosAusencia();
        cargarEstadoControlBot();
    } catch (err) {
        alert("Error al programar evento: " + err.message);
    }
}

async function eliminarEventoAusencia(id) {
    if (!confirm("¿Deseas eliminar este evento programado?")) return;
    try {
        await apiFetch(`/api/bot/eventos-ausencia/${id}`, { method: 'DELETE' });
        cargarListaEventosAusencia();
        cargarEstadoControlBot();
    } catch (err) {
        alert("Error al eliminar evento: " + err.message);
    }
}

function autollenarFestivoOficial(nombre, mmDdInicio, mmDdFin) {
    const anioActual = new Date().getFullYear();
    const tipoSelect = document.getElementById('nuevo-evento-tipo');
    if (tipoSelect) tipoSelect.value = 'festivo';
    
    const tituloInput = document.getElementById('nuevo-evento-titulo');
    if (tituloInput) tituloInput.value = nombre;
    
    const inicioInput = document.getElementById('nuevo-evento-inicio');
    if (inicioInput) inicioInput.value = `${anioActual}-${mmDdInicio}`;
    
    const finInput = document.getElementById('nuevo-evento-fin');
    if (finInput) finInput.value = `${anioActual}-${mmDdFin}`;

    const reanudacionInput = document.getElementById('nuevo-evento-reanudacion');
    if (reanudacionInput) reanudacionInput.value = 'al día hábil siguiente a primera hora';
}

function actualizarSugerenciasNuevoEvento() {
    const tipo = document.getElementById('nuevo-evento-tipo').value;
    const tituloInput = document.getElementById('nuevo-evento-titulo');
    if (tipo === 'festivo' && (!tituloInput.value || tituloInput.value.includes('Curso') || tituloInput.value.includes('Vacaciones'))) {
        tituloInput.placeholder = "Ej: Aniversario de la Independencia";
    } else if (tipo === 'curso' && (!tituloInput.value || tituloInput.value.includes('Festivo') || tituloInput.value.includes('Vacaciones'))) {
        tituloInput.placeholder = "Ej: Congreso de Actualización Médica Continua";
    } else if (tipo === 'vacaciones') {
        tituloInput.placeholder = "Ej: Periodo Vacacional de Invierno";
    }
}

async function abrirModalIgnorados() {
    document.getElementById('modal-ignorados').classList.remove('hidden');
    renderizarListaIgnorados();
}

function cerrarModalIgnorados() {
    document.getElementById('modal-ignorados').classList.add('hidden');
}

async function renderizarListaIgnorados() {
    const cont = document.getElementById('lista-ignorados-container');
    try {
        const lista = await apiFetch('/api/contactos/ignorados');
        if (!lista || lista.length === 0) {
            cont.innerHTML = `<p class="text-xs text-slate-500 text-center py-4">No hay ningún contacto en la lista de ignorados.</p>`;
            return;
        }

        cont.innerHTML = lista.map(c => `
            <div class="flex items-center justify-between p-3 bg-slate-900 rounded-xl border border-slate-800 text-xs">
                <div>
                    <span class="font-bold text-white block">${c.nombre !== 'Cliente' ? c.nombre : (c.pushname || 'Contacto')}</span>
                    <span class="text-slate-400 font-mono text-[11px]">+${c.telefono || c.jid.replace(/[^0-9]/g, '')}</span>
                </div>
                <button onclick="toggleIgnorarContacto('${c.jid}', false)" class="px-2.5 py-1 bg-emerald-600/20 hover:bg-emerald-600/40 text-emerald-400 border border-emerald-500/30 rounded-lg text-[11px] font-bold transition">
                    Volver a Atender
                </button>
            </div>
        `).join('');
    } catch (e) {
        cont.innerHTML = `<p class="text-xs text-rose-400 text-center py-4">Error al cargar lista: ${e.message}</p>`;
    }
}

async function toggleIgnorarContacto(jid, esIgnorado) {
    try {
        await apiFetch('/api/contactos/toggle-ignorar', {
            method: 'POST',
            body: JSON.stringify({ jid, es_ignorado: esIgnorado })
        });
        renderizarListaIgnorados();
        cargarEstadoControlBot();
    } catch (e) {
        alert("Error al actualizar contacto: " + e.message);
    }
}

async function agregarIgnoradoManual(e) {
    e.preventDefault();
    const input = document.getElementById('input-ignorar-numero');
    const num = input.value.trim().replace(/[^0-9]/g, '');
    if (!num) return;

    const jid = num.length === 10 ? `521${num}@c.us` : `${num}@c.us`;
    await toggleIgnorarContacto(jid, true);
    input.value = '';
}

function descargarRespaldoBD() {
    window.location.href = `/api/backup/descargar?token=${token}`;
}

// ==============================================================================
// GESTIÓN DE DOCUMENTOS Y GALERÍA DE INFOGRAFÍAS / PROMOS
// ==============================================================================
async function cargarDocumentosConocimiento() {
    const cont = document.getElementById('lista-documentos-container');
    if (!cont) return;
    try {
        const docs = await apiFetch('/api/documentos');
        if (!docs || docs.length === 0) {
            cont.innerHTML = `<div class="p-4 bg-slate-950 border border-slate-800 rounded-2xl text-xs text-slate-500 text-center">No hay documentos de catálogo o precios subidos aún.</div>`;
            return;
        }
        cont.innerHTML = docs.map(d => `
            <div class="flex items-center justify-between p-3.5 bg-slate-950 border border-slate-800 rounded-2xl text-xs">
                <div class="flex items-center space-x-3">
                    <i class="fa-solid fa-file-lines text-indigo-400 text-sm"></i>
                    <div>
                        <span class="font-bold text-white block">${d.nombre}</span>
                        <span class="text-[10px] text-slate-400">${d.tamano} • Subido el ${d.fecha}</span>
                    </div>
                </div>
                <button onclick="eliminarDocumentoConocimiento('${d.nombre}')" class="text-slate-500 hover:text-rose-400 p-2 transition">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </div>
        `).join('');
    } catch(e) {
        cont.innerHTML = `<div class="text-xs text-rose-400 text-center py-2">Error cargando documentos: ${e.message}</div>`;
    }
}

async function subirDocumentoConocimiento(input) {
    if (!input.files || input.files.length === 0) return;
    const file = input.files[0];
    const formData = new FormData();
    formData.append('documento', file);

    try {
        const res = await fetch('/api/documentos/upload', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` },
            body: formData
        });
        const data = await res.json();
        if (data.success) {
            alert(`✅ Documento "${file.name}" subido con éxito.`);
            cargarDocumentosConocimiento();
        } else {
            alert("Error al subir: " + data.error);
        }
    } catch(e) {
        alert("Error de red: " + e.message);
    }
    input.value = '';
}

async function eliminarDocumentoConocimiento(nombre) {
    if (!confirm(`¿Deseas eliminar el documento "${nombre}"?`)) return;
    try {
        await apiFetch(`/api/documentos/${encodeURIComponent(nombre)}`, { method: 'DELETE' });
        cargarDocumentosConocimiento();
    } catch(e) {
        alert("Error al eliminar: " + e.message);
    }
}

// Galería de Infografías e Imágenes Automáticas
async function cargarInfografiasImagenes() {
    const cont = document.getElementById('lista-infografias-container');
    if (!cont) return;
    try {
        const imgs = await apiFetch('/api/imagenes');
        if (!imgs || imgs.length === 0) {
            cont.innerHTML = `<div class="p-4 bg-slate-950 border border-slate-800 rounded-2xl text-xs text-slate-500 text-center col-span-full">No hay imágenes en la galería aún. Sube tus infografías o promociones con el botón superior.</div>`;
            return;
        }
        cont.innerHTML = imgs.map(img => `
            <div class="bg-slate-950 border border-slate-800 rounded-2xl overflow-hidden group hover:border-indigo-500/50 transition flex flex-col justify-between">
                <div class="h-32 bg-slate-900 overflow-hidden flex items-center justify-center p-2 relative">
                    <img src="${img.url}" alt="${img.nombre}" class="max-h-full max-w-full object-contain rounded-lg">
                </div>
                <div class="p-3 border-t border-slate-800/80 flex items-center justify-between">
                    <div class="min-w-0 pr-2">
                        <span class="font-bold text-white text-[11px] block truncate" title="${img.nombre}">${img.nombre}</span>
                        <span class="text-[10px] text-slate-500 font-mono">${img.tamano}</span>
                    </div>
                    <button onclick="eliminarInfografiaImagen('${img.nombre}')" class="text-slate-500 hover:text-rose-400 p-1.5 transition text-xs flex-shrink-0" title="Eliminar imagen">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            </div>
        `).join('');
    } catch(e) {
        cont.innerHTML = `<div class="text-xs text-rose-400 text-center py-2 col-span-full">Error cargando galería: ${e.message}</div>`;
    }
}

async function subirInfografiaImagen(input) {
    if (!input.files || input.files.length === 0) return;
    const file = input.files[0];
    const formData = new FormData();
    formData.append('imagen', file);

    try {
        const res = await fetch('/api/imagenes/upload', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` },
            body: formData
        });
        const data = await res.json();
        if (data.success) {
            alert(`✅ Imagen "${file.name}" subida con éxito.`);
            cargarInfografiasImagenes();
        } else {
            alert("Error al subir imagen: " + data.error);
        }
    } catch(e) {
        alert("Error de red: " + e.message);
    }
    input.value = '';
}

async function eliminarInfografiaImagen(nombre) {
    if (!confirm(`¿Deseas eliminar la imagen "${nombre}"?`)) return;
    try {
        await apiFetch(`/api/imagenes/${encodeURIComponent(nombre)}`, { method: 'DELETE' });
        cargarInfografiasImagenes();
    } catch(e) {
        alert("Error al eliminar imagen: " + e.message);
    }
}

// ==============================================================================
// GESTIÓN DE ETIQUETAS DE CONTACTO (MODAL & CRM)
// ==============================================================================
async function sincronizarEtiquetasWhatsApp() {
    try {
        const btn = event?.currentTarget;
        let originalHtml = '';
        if (btn) {
            originalHtml = btn.innerHTML;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin text-[9px]"></i> <span>Importando...</span>';
            btn.disabled = true;
        }

        const res = await apiFetch('/api/etiquetas/sincronizar-whatsapp', { method: 'POST' });
        if (res.success) {
            alert("✅ " + res.message);
            await cargarEtiquetasFiltro();
            await cargarListaConversaciones();
            if (chatActivoJid) {
                const nomElem = document.getElementById('chat-nombre-cliente');
                seleccionarChat(chatActivoJid, nomElem ? nomElem.textContent : '');
            }
        } else {
            alert("Aviso: " + (res.error || 'No se pudo sincronizar'));
        }

        if (btn) {
            btn.innerHTML = originalHtml;
            btn.disabled = false;
        }
    } catch (e) {
        alert("Error de sincronización con WhatsApp: " + e.message);
    }
}

async function abrirModalEtiquetasContacto() {
    if (!chatActivoJid) return alert("Selecciona un chat primero");
    const nomElem = document.getElementById('chat-nombre-cliente');
    document.getElementById('modal-etiquetas-nombre-cliente').textContent = nomElem ? nomElem.textContent : '';

    try {
        const [todasEtiquetas, tagsContacto] = await Promise.all([
            apiFetch('/api/etiquetas'),
            apiFetch(`/api/contactos/${encodeURIComponent(chatActivoJid)}/etiquetas`)
        ]);

        const idsAsignados = new Set((tagsContacto || []).map(t => t.id));
        const cont = document.getElementById('modal-etiquetas-lista-check');
        if (!cont) return;

        if (!todasEtiquetas || todasEtiquetas.length === 0) {
            cont.innerHTML = '<p class="text-xs text-slate-500 py-2">No hay etiquetas creadas aún.</p>';
        } else {
            cont.innerHTML = todasEtiquetas.map(e => {
                const checked = idsAsignados.has(e.id) ? 'checked' : '';
                return `
                    <label class="flex items-center justify-between p-2.5 rounded-xl bg-slate-950 border border-slate-800 hover:border-slate-700 cursor-pointer transition">
                        <div class="flex items-center space-x-2.5">
                            <span class="w-3 h-3 rounded-full flex-shrink-0" style="background-color: ${e.color};"></span>
                            <span class="font-bold text-xs text-white">${e.nombre}</span>
                        </div>
                        <input type="checkbox" onchange="toggleEtiquetaContacto(${e.id}, this.checked)" ${checked} class="w-4 h-4 rounded text-indigo-600 bg-slate-900 border-slate-700 focus:ring-indigo-500 cursor-pointer">
                    </label>
                `;
            }).join('');
        }

        document.getElementById('modal-etiquetas-contacto').classList.remove('hidden');
    } catch (e) {
        alert("Error al cargar etiquetas: " + e.message);
    }
}

function cerrarModalEtiquetasContacto() {
    document.getElementById('modal-etiquetas-contacto').classList.add('hidden');
    if (chatActivoJid) {
        seleccionarChat(chatActivoJid, document.getElementById('chat-nombre-cliente').textContent);
    }
    cargarListaConversaciones();
}

async function toggleEtiquetaContacto(etiquetaId, estaMarcado) {
    if (!chatActivoJid) return;
    try {
        await apiFetch(`/api/contactos/${encodeURIComponent(chatActivoJid)}/etiquetas`, {
            method: 'POST',
            body: JSON.stringify({
                etiqueta_id: etiquetaId,
                accion: estaMarcado ? 'asignar' : 'quitar'
            })
        });
    } catch (e) {
        alert("Error al actualizar etiqueta: " + e.message);
    }
}

// Modal Crear Nueva Etiqueta
function abrirModalNuevaEtiqueta() {
    document.getElementById('form-nueva-etiqueta').reset();
    document.getElementById('input-etiqueta-id').value = '';
    document.getElementById('input-etiqueta-color').value = '#10b981';
    document.getElementById('modal-etiqueta-titulo').textContent = 'Nueva Lista / Etiqueta';
    document.getElementById('modal-nueva-etiqueta').classList.remove('hidden');
}

function cerrarModalNuevaEtiqueta() {
    document.getElementById('modal-nueva-etiqueta').classList.add('hidden');
}

async function guardarNuevaEtiqueta(e) {
    e.preventDefault();
    const id = document.getElementById('input-etiqueta-id').value;
    const nombre = document.getElementById('input-etiqueta-nombre').value.trim();
    const color = document.getElementById('input-etiqueta-color').value;

    if (!nombre) return alert("Ingresa un nombre para la etiqueta");

    try {
        const url = id ? `/api/etiquetas/${id}` : '/api/etiquetas';
        const method = id ? 'PUT' : 'POST';
        await apiFetch(url, {
            method,
            body: JSON.stringify({ nombre, color })
        });
        cerrarModalNuevaEtiqueta();
        await cargarEtiquetasFiltro();
        await cargarListaConversaciones();
        if (chatActivoJid) abrirModalEtiquetasContacto();
    } catch (err) {
        alert("Error al guardar etiqueta: " + err.message);
    }
}

// ==============================================================================
// MÓDULO UNIVERSAL DE SEGUIMIENTOS Y RECORDATORIOS PROGRAMADOS
// ==============================================================================
async function cargarReglasSeguimiento() {
    const cont = document.getElementById('contenedor-reglas-seguimiento');
    if (!cont) return;
    try {
        listaReglasSeguimientoMem = await apiFetch('/api/seguimientos/reglas');
        if (!listaReglasSeguimientoMem || listaReglasSeguimientoMem.length === 0) {
            cont.innerHTML = `<div class="p-6 bg-slate-950 border border-slate-800 rounded-2xl text-center text-xs text-slate-500 col-span-full">No hay reglas de seguimiento configuradas. Crea una con el botón "+ Nueva Regla de Seguimiento".</div>`;
            return;
        }

        cont.innerHTML = listaReglasSeguimientoMem.map(r => `
            <div class="p-4 bg-slate-950 border border-slate-800/80 rounded-2xl space-y-3 flex flex-col justify-between hover:border-slate-700 transition">
                <div class="space-y-1.5">
                    <div class="flex items-center justify-between">
                        <h4 class="font-bold text-white text-xs">${r.nombre}</h4>
                        <span class="px-2 py-0.5 rounded text-[10px] font-bold ${r.activo === 1 ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-slate-800 text-slate-500'}">
                            ${r.activo === 1 ? 'Activa' : 'Inactiva'}
                        </span>
                    </div>

                    <div class="flex items-center space-x-2 text-[11px] text-slate-400">
                        <span>Aplica a:</span>
                        ${r.etiqueta_nombre 
                            ? `<span class="px-1.5 py-0.5 rounded text-[10px] font-bold text-white" style="background-color: ${r.etiqueta_color || '#6366f1'};">${r.etiqueta_nombre}</span>` 
                            : `<span class="px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 text-[10px] font-semibold">Todos los clientes</span>`}
                    </div>

                    <p class="text-[11px] text-slate-400">
                        ⏳ Enviar tras: <b class="text-amber-400">${r.dias_espera} días</b> • Hora diaria: <b class="text-indigo-400">${r.hora_envio || '10:30'}</b> • Modo: <b class="text-slate-200">${r.modo_envio === 'automatico' ? 'Automático' : 'Manual'}</b>
                    </p>

                    <div class="bg-slate-900/80 p-2.5 rounded-xl border border-slate-800 text-[11px] text-slate-300 italic line-clamp-2">
                        "${r.mensaje_plantilla}"
                    </div>
                </div>

                <div class="flex items-center justify-end space-x-2 pt-2 border-t border-slate-900">
                    <button onclick="abrirModalEditarReglaSeguimiento(${JSON.stringify(r).replace(/"/g, '&quot;')})" class="px-3 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-semibold transition" title="Editar">
                        <i class="fa-solid fa-pen-to-square mr-1"></i>Editar
                    </button>
                    <button onclick="eliminarReglaSeguimiento(${r.id})" class="px-3 py-1 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/30 rounded-lg text-xs font-semibold transition" title="Eliminar">
                        <i class="fa-solid fa-trash mr-1"></i>Eliminar
                    </button>
                </div>
            </div>
        `).join('');
    } catch (e) {
        cont.innerHTML = `<div class="text-xs text-rose-400 text-center py-2 col-span-full">Error al cargar reglas: ${e.message}</div>`;
    }
}

async function cargarSeguimientosPendientes() {
    const tbody = document.getElementById('tabla-seguimientos-pendientes');
    if (!tbody) return;
    try {
        const pendientes = await apiFetch('/api/seguimientos/pendientes');
        if (!pendientes || pendientes.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5" class="p-6 text-center text-slate-500 text-xs">No hay contactos pendientes de seguimiento hoy. El sistema notificará cuando cumplan su periodo.</td></tr>`;
            return;
        }

        tbody.innerHTML = pendientes.map(p => `
            <tr class="hover:bg-slate-900/60 transition">
                <td class="p-3">
                    <b class="text-white block">${p.nombre}</b>
                    <span class="text-[10px] text-slate-400 font-mono">${p.telefono || p.jid.replace('@c.us', '')}</span>
                </td>
                <td class="p-3 text-slate-300">${p.regla_nombre}</td>
                <td class="p-3 font-semibold text-amber-400">${p.dias_transcurridos} días transcurridos</td>
                <td class="p-3 text-[11px] text-slate-300 max-w-xs truncate" title="${p.mensaje_preparado}">
                    ${p.mensaje_preparado}
                </td>
                <td class="p-3 text-right">
                    <button onclick="enviarSeguimientoManual('${p.jid}', ${p.regla_id}, '${p.mensaje_preparado.replace(/'/g, "\\'")}')" class="px-3.5 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-bold transition shadow-sm flex items-center space-x-1.5 ml-auto">
                        <i class="fa-solid fa-paper-plane text-[10px]"></i>
                        <span>Enviar Ahora</span>
                    </button>
                </td>
            </tr>
        `).join('');
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="5" class="p-4 text-center text-rose-400 text-xs">Error: ${e.message}</td></tr>`;
    }
}

async function enviarSeguimientoManual(jid, reglaId, mensaje) {
    if (!confirm(`¿Deseas enviar el recordatorio de seguimiento a este contacto ahora?`)) return;
    try {
        const res = await apiFetch('/api/seguimientos/enviar', {
            method: 'POST',
            body: JSON.stringify({ jid, regla_id: reglaId, mensaje })
        });
        if (res.success) {
            alert("✅ " + res.message);
            cargarSeguimientosPendientes();
            if (chatActivoJid === jid) seleccionarChat(jid, document.getElementById('chat-nombre-cliente').textContent);
        }
    } catch (e) {
        alert("Error al enviar seguimiento: " + e.message);
    }
}

function abrirModalNuevaReglaSeguimiento() {
    document.getElementById('form-regla-seguimiento').reset();
    document.getElementById('input-regla-id').value = '';
    document.getElementById('input-regla-dias').value = 90;
    document.getElementById('input-regla-hora').value = '10:30';
    document.getElementById('modal-regla-titulo').textContent = 'Nueva Regla de Seguimiento Programado';
    cargarEtiquetasFiltro();
    document.getElementById('modal-regla-seguimiento').classList.remove('hidden');
}

function abrirModalEditarReglaSeguimiento(r) {
    document.getElementById('input-regla-id').value = r.id;
    document.getElementById('input-regla-nombre').value = r.nombre;
    document.getElementById('select-regla-etiqueta').value = r.etiqueta_id || '';
    document.getElementById('input-regla-dias').value = r.dias_espera;
    document.getElementById('input-regla-hora').value = r.hora_envio || '10:30';
    document.getElementById('select-regla-modo').value = r.modo_envio || 'automatico';
    document.getElementById('input-regla-plantilla').value = r.mensaje_plantilla;
    document.getElementById('modal-regla-titulo').textContent = 'Editar Regla de Seguimiento';
    document.getElementById('modal-regla-seguimiento').classList.remove('hidden');
}

function cerrarModalReglaSeguimiento() {
    document.getElementById('modal-regla-seguimiento').classList.add('hidden');
}

async function guardarReglaSeguimiento(e) {
    e.preventDefault();
    const id = document.getElementById('input-regla-id').value;
    const nombre = document.getElementById('input-regla-nombre').value.trim();
    const etiqueta_id = document.getElementById('select-regla-etiqueta').value || null;
    const dias_espera = parseInt(document.getElementById('input-regla-dias').value, 10);
    const hora_envio = document.getElementById('input-regla-hora').value;
    const modo_envio = document.getElementById('select-regla-modo').value;
    const mensaje_plantilla = document.getElementById('input-regla-plantilla').value.trim();

    if (!nombre || !mensaje_plantilla) return alert("Completa los campos obligatorios");

    try {
        const url = id ? `/api/seguimientos/reglas/${id}` : '/api/seguimientos/reglas';
        const method = id ? 'PUT' : 'POST';
        await apiFetch(url, {
            method,
            body: JSON.stringify({ nombre, etiqueta_id, dias_espera, hora_envio, modo_envio, mensaje_plantilla })
        });
        cerrarModalReglaSeguimiento();
        cargarReglasSeguimiento();
        cargarSeguimientosPendientes();
    } catch (err) {
        alert("Error al guardar regla: " + err.message);
    }
}

async function eliminarReglaSeguimiento(id) {
    if (!confirm("¿Deseas eliminar esta regla de seguimiento?")) return;
    try {
        await apiFetch(`/api/seguimientos/reglas/${id}`, { method: 'DELETE' });
        cargarReglasSeguimiento();
        cargarSeguimientosPendientes();
    } catch (err) {
        alert("Error al eliminar regla: " + err.message);
    }
}

// Gestión de Modo Claro / Oscuro (Light & Dark Mode)
function aplicarTema(tema) {
    const body = document.getElementById('app-body');
    const icon = document.getElementById('theme-icon');
    const btn = document.getElementById('btn-theme-toggle');
    if (!body) return;

    if (tema === 'light') {
        body.classList.add('light-theme');
        if (icon) {
            icon.classList.remove('fa-sun');
            icon.classList.add('fa-moon');
        }
        if (btn) btn.title = "Cambiar a Modo Oscuro";
        localStorage.setItem('omnibot_theme', 'light');
    } else {
        body.classList.remove('light-theme');
        if (icon) {
            icon.classList.remove('fa-moon');
            icon.classList.add('fa-sun');
        }
        if (btn) btn.title = "Cambiar a Modo Claro";
        localStorage.setItem('omnibot_theme', 'dark');
    }
}

function alternarTema() {
    const body = document.getElementById('app-body');
    const esLight = body && body.classList.contains('light-theme');
    aplicarTema(esLight ? 'dark' : 'light');
}

// Inicializar tema guardado al cargar
(function() {
    const temaGuardado = localStorage.getItem('omnibot_theme') || 'dark';
    aplicarTema(temaGuardado);
})();

// Escuchar actualizaciones de estado de control en tiempo real vía Socket.io
socket.on('estado_control_actualizado', () => {
    cargarEstadoControlBot();
});

socket.on('eventos_ausencia_actualizados', () => {
    cargarListaEventosAusencia();
    cargarEstadoControlBot();
});

// Inicializar vista por defecto y estado del bot
cambiarTab('ventas');
cargarEstadoControlBot();

// Auto-sincronización periódica en segundo plano cada 15 segundos
setInterval(() => {
    cargarEstadoControlBot();
}, 15000);

// ==============================================================================
// GESTIÓN DE ACCIONES RÁPIDAS EN LIVE CHAT (INFOGRAFÍAS, ADJUNTOS, ENLACES, RESPUESTAS)
// ==============================================================================

let infografiaSeleccionada = null;

const MAPA_NOMBRES_INFOGRAFIAS = {
    'implante.png': 'Implante Subdérmico',
    'vasectomia.png': 'Vasectomía sin Bisturí',
    'preparacion_vasectomia.png': 'Preparación Vasectomía',
    'diu_cobre.png': 'DIU de Cobre (T de Cobre)',
    'diu_medicado.png': 'DIU Medicado (Mirena / Levonorgestrel)',
    'metodos.png': 'Catálogo Completo de Métodos',
    'emergencia.png': 'Pastilla Anticonceptiva de Emergencia',
    'parche.png': 'Parche Anticonceptivo Transdérmico',
    'pastillas.png': 'Pastillas Anticonceptivas Orales',
    'inyeccion_mensual.png': 'Inyección Mensual',
    'inyeccion_bimensual.png': 'Inyección Bimensual (2 meses)',
    'inyeccion_trimestral.png': 'Inyección Trimestral (3 meses)'
};

function formatearNombreInfografia(archivo) {
    if (MAPA_NOMBRES_INFOGRAFIAS[archivo]) return MAPA_NOMBRES_INFOGRAFIAS[archivo];
    return archivo.replace(/\.[^/.]+$/, "").replace(/[_-]/g, " ").replace(/\b\w/g, l => l.toUpperCase());
}

async function abrirModalInfografias() {
    if (!chatActivoJid) {
        alert("Por favor selecciona una conversación en la lista antes de enviar una infografía.");
        return;
    }
    const modal = document.getElementById('modal-infografias');
    if (!modal) return;

    infografiaSeleccionada = null;
    const captionInput = document.getElementById('input-infografia-caption');
    if (captionInput) captionInput.value = '';

    const labelSel = document.getElementById('label-infografia-seleccionada');
    if (labelSel) labelSel.textContent = 'Ninguna infografía seleccionada';

    const btnConfirmar = document.getElementById('btn-enviar-infografia-confirmar');
    if (btnConfirmar) {
        btnConfirmar.disabled = true;
        btnConfirmar.innerHTML = `<i class="fa-solid fa-paper-plane text-xs"></i> <span>Enviar por WhatsApp</span>`;
    }

    modal.classList.remove('hidden');

    const grid = document.getElementById('galeria-infografias-grid');
    if (grid) {
        grid.innerHTML = `<div class="col-span-full py-8 text-center text-slate-400 text-xs"><i class="fa-solid fa-circle-notch fa-spin text-base text-indigo-400 mr-2"></i>Cargando infografías del servidor...</div>`;
    }

    try {
        const imagenes = await apiFetch('/api/imagenes');
        if (!grid) return;

        if (!Array.isArray(imagenes) || imagenes.length === 0) {
            grid.innerHTML = `<div class="col-span-full py-8 text-center text-slate-400 text-xs">No hay imágenes disponibles en el servidor actualmente.</div>`;
            return;
        }

        grid.innerHTML = imagenes.map(img => {
            const titulo = formatearNombreInfografia(img.nombre);
            const kb = img.tamano ? (img.tamano / 1024).toFixed(0) + ' KB' : '';
            return `
                <div class="tarjeta-infografia-item cursor-pointer group bg-slate-950/60 hover:bg-slate-800/80 border border-slate-800 hover:border-indigo-500/60 rounded-2xl p-2.5 flex flex-col transition text-left" 
                     data-archivo="${img.nombre}" 
                     data-titulo="${titulo}" 
                     onclick="seleccionarInfografiaTarjeta('${img.nombre}', '${titulo.replace(/'/g, "\\'")}', this)">
                    <div class="h-28 w-full bg-slate-900 rounded-xl overflow-hidden mb-2 border border-slate-800/60 relative flex items-center justify-center">
                        <img src="/imagenes/${encodeURIComponent(img.nombre)}" alt="${titulo}" class="w-full h-full object-cover group-hover:scale-105 transition duration-300" loading="lazy">
                        <div class="absolute inset-0 bg-indigo-600/0 group-hover:bg-indigo-600/10 transition"></div>
                    </div>
                    <div class="font-bold text-slate-200 text-xs truncate group-hover:text-indigo-300" title="${titulo}">${titulo}</div>
                    <div class="text-[10px] text-slate-500 flex items-center justify-between mt-1">
                        <span class="truncate">${img.nombre}</span>
                        ${kb ? `<span>${kb}</span>` : ''}
                    </div>
                </div>
            `;
        }).join('');
    } catch (err) {
        if (grid) {
            grid.innerHTML = `<div class="col-span-full py-8 text-center text-rose-400 text-xs">Error al cargar infografías: ${err.message}</div>`;
        }
    }
}

function seleccionarInfografiaTarjeta(nombreArchivo, tituloAmigable, elementoHtml) {
    infografiaSeleccionada = nombreArchivo;

    document.querySelectorAll('.tarjeta-infografia-item').forEach(el => {
        el.classList.remove('border-indigo-500', 'bg-indigo-950/40', 'ring-2', 'ring-indigo-500/50');
    });

    if (elementoHtml) {
        elementoHtml.classList.add('border-indigo-500', 'bg-indigo-950/40', 'ring-2', 'ring-indigo-500/50');
    }

    const labelSel = document.getElementById('label-infografia-seleccionada');
    if (labelSel) {
        labelSel.innerHTML = `<span class="text-indigo-400 font-bold">Seleccionada:</span> ${tituloAmigable}`;
    }

    const btnConfirmar = document.getElementById('btn-enviar-infografia-confirmar');
    if (btnConfirmar) {
        btnConfirmar.disabled = false;
    }
}

function cerrarModalInfografias() {
    const modal = document.getElementById('modal-infografias');
    if (modal) modal.classList.add('hidden');
}

async function confirmarEnvioInfografia() {
    if (!chatActivoJid) return alert("Selecciona una conversación primero.");
    if (!infografiaSeleccionada) return alert("Por favor selecciona una infografía de la galería.");

    const btnConfirmar = document.getElementById('btn-enviar-infografia-confirmar');
    const caption = document.getElementById('input-infografia-caption')?.value || '';

    if (btnConfirmar) {
        btnConfirmar.disabled = true;
        btnConfirmar.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin text-xs"></i> <span>Enviando...</span>`;
    }

    try {
        await apiFetch(`/api/conversaciones/${encodeURIComponent(chatActivoJid)}/enviar-imagen`, {
            method: 'POST',
            body: JSON.stringify({
                nombre_imagen: infografiaSeleccionada,
                caption: caption
            })
        });

        cerrarModalInfografias();

        const nomElem = document.getElementById('chat-nombre-cliente');
        seleccionarChat(chatActivoJid, nomElem ? nomElem.textContent : '');
    } catch (err) {
        alert("Error al enviar infografía por WhatsApp: " + err.message);
        if (btnConfirmar) {
            btnConfirmar.disabled = false;
            btnConfirmar.innerHTML = `<i class="fa-solid fa-paper-plane text-xs"></i> <span>Enviar por WhatsApp</span>`;
        }
    }
}

async function enviarImagenLocalChat(event) {
    if (!chatActivoJid) {
        alert("Por favor selecciona una conversación antes de adjuntar un archivo.");
        event.target.value = '';
        return;
    }

    const file = event.target.files && event.target.files[0];
    if (!file) return;

    const confirma = confirm(`¿Deseas enviar la imagen "${file.name}" a este cliente por WhatsApp?`);
    if (!confirma) {
        event.target.value = '';
        return;
    }

    const caption = prompt("Pie de foto o mensaje adjunto para la imagen (opcional):", "") || "";

    const formData = new FormData();
    formData.append('imagen', file);
    if (caption.trim()) {
        formData.append('caption', caption.trim());
    }

    try {
        await apiFetch(`/api/conversaciones/${encodeURIComponent(chatActivoJid)}/enviar-imagen`, {
            method: 'POST',
            body: formData
        });

        event.target.value = '';

        const nomElem = document.getElementById('chat-nombre-cliente');
        seleccionarChat(chatActivoJid, nomElem ? nomElem.textContent : '');
    } catch (err) {
        alert("Error al enviar archivo por WhatsApp: " + err.message);
        event.target.value = '';
    }
}

// ------------------------------------------------------------------------------
// ENLACES RÁPIDOS Y FORMULARIOS (Google Maps, Privacidad, Cuestionarios, etc.)
// ------------------------------------------------------------------------------
let listaEnlacesRapidosMem = [];

async function abrirModalEnlacesRapidos() {
    if (!chatActivoJid) {
        alert("Por favor selecciona una conversación en la lista.");
        return;
    }

    const modal = document.getElementById('modal-enlaces-rapidos');
    if (!modal) return;
    modal.classList.remove('hidden');

    await cargarEnlacesRapidosModal();
}

function cerrarModalEnlacesRapidos() {
    const modal = document.getElementById('modal-enlaces-rapidos');
    if (modal) modal.classList.add('hidden');
}

async function cargarEnlacesRapidosModal() {
    const lista = document.getElementById('lista-enlaces-sistema');
    if (!lista) return;

    lista.innerHTML = `<div class="py-6 text-center text-slate-400 text-xs"><i class="fa-solid fa-circle-notch fa-spin mr-2"></i>Cargando enlaces y formularios...</div>`;

    try {
        const enlaces = await apiFetch('/api/enlaces-rapidos');
        listaEnlacesRapidosMem = Array.isArray(enlaces) ? enlaces : [];

        if (listaEnlacesRapidosMem.length === 0) {
            lista.innerHTML = `<div class="py-4 text-center text-slate-400 text-xs">No hay enlaces guardados. Haz clic en "Nuevo Enlace" para agregar uno.</div>`;
            return;
        }

        lista.innerHTML = listaEnlacesRapidosMem.map(item => {
            const tieneUrlValida = item.url && item.url.trim() && item.url.startsWith('http');
            const textoPegar = `🔗 *${item.titulo}:* ${item.url}`;
            const icono = item.icono || 'fa-link';
            const color = item.color || 'text-indigo-400';

            return `
                <div class="bg-slate-950/60 border border-slate-800 hover:border-slate-700 rounded-2xl p-3 flex items-center justify-between gap-3 transition">
                    <div class="flex items-center space-x-3 overflow-hidden flex-1 min-w-0">
                        <div class="w-9 h-9 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-center flex-shrink-0">
                            <i class="fa-solid ${icono} ${color} text-sm"></i>
                        </div>
                        <div class="overflow-hidden flex-1 min-w-0">
                            <div class="flex items-center space-x-1.5">
                                <span class="font-bold text-slate-200 text-xs truncate">${item.titulo}</span>
                            </div>
                            <div class="text-[10px] text-slate-400 truncate">${item.descripcion || item.url}</div>
                            ${!tieneUrlValida ? `<div class="text-[9px] text-amber-400 font-semibold mt-0.5">⚠️ URL pendiente de configurar (haz clic en Editar)</div>` : ''}
                        </div>
                    </div>
                    <div class="flex items-center space-x-1.5 flex-shrink-0">
                        ${tieneUrlValida ? `
                            <a href="${item.url}" target="_blank" class="w-7 h-7 bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-white rounded-lg flex items-center justify-center text-xs transition" title="Abrir enlace en nueva pestaña">
                                <i class="fa-solid fa-arrow-up-right-from-square text-[10px]"></i>
                            </a>
                        ` : ''}
                        <button type="button" onclick="abrirModalEditarEnlaceRapido(${item.id})" class="w-7 h-7 bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-indigo-300 rounded-lg flex items-center justify-center text-xs transition" title="Editar título, descripción o URL">
                            <i class="fa-solid fa-pen text-[10px]"></i>
                        </button>
                        <button type="button" onclick="insertarEnlaceEnInput('${textoPegar.replace(/'/g, "\\'")}')" class="px-3 py-1.5 bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 border border-indigo-500/30 rounded-xl text-xs font-bold transition flex items-center space-x-1">
                            <i class="fa-solid fa-arrow-turn-down text-[10px]"></i>
                            <span>Pegar</span>
                        </button>
                    </div>
                </div>
            `;
        }).join('');
    } catch (err) {
        lista.innerHTML = `<div class="py-4 text-center text-rose-400 text-xs">Error al cargar enlaces: ${err.message}</div>`;
    }
}

function abrirModalCrearEnlaceRapido() {
    const modal = document.getElementById('modal-editar-enlace-rapido');
    if (!modal) return;
    document.getElementById('titulo-modal-editar-enlace').textContent = "Nuevo Enlace o Formulario";
    document.getElementById('input-enlace-id').value = "";
    document.getElementById('input-enlace-titulo').value = "";
    document.getElementById('input-enlace-desc').value = "";
    document.getElementById('input-enlace-url').value = "";
    modal.classList.remove('hidden');
}

function abrirModalEditarEnlaceRapido(id) {
    const modal = document.getElementById('modal-editar-enlace-rapido');
    if (!modal) return;
    const item = listaEnlacesRapidosMem.find(e => e.id === id);
    if (!item) return;

    document.getElementById('titulo-modal-editar-enlace').textContent = "Personalizar Enlace / Formulario";
    document.getElementById('input-enlace-id').value = item.id;
    document.getElementById('input-enlace-titulo').value = item.titulo || "";
    document.getElementById('input-enlace-desc').value = item.descripcion || "";
    document.getElementById('input-enlace-url').value = item.url || "";
    modal.classList.remove('hidden');
}

function cerrarModalEditarEnlaceRapido() {
    const modal = document.getElementById('modal-editar-enlace-rapido');
    if (modal) modal.classList.add('hidden');
}

async function guardarEnlaceRapido(event) {
    event.preventDefault();
    const id = document.getElementById('input-enlace-id')?.value;
    const titulo = document.getElementById('input-enlace-titulo')?.value?.trim();
    const descripcion = document.getElementById('input-enlace-desc')?.value?.trim();
    const url = document.getElementById('input-enlace-url')?.value?.trim();

    if (!titulo || !url) return alert("El título y la URL son obligatorios.");

    try {
        await apiFetch('/api/enlaces-rapidos', {
            method: 'POST',
            body: JSON.stringify({
                id: id ? parseInt(id, 10) : undefined,
                titulo,
                descripcion,
                url
            })
        });

        cerrarModalEditarEnlaceRapido();
        await cargarEnlacesRapidosModal();
    } catch (err) {
        alert("Error al guardar enlace: " + err.message);
    }
}

async function eliminarEnlaceRapido(id) {
    if (!confirm("¿Deseas eliminar este enlace rápido?")) return;
    try {
        await apiFetch(`/api/enlaces-rapidos/${id}`, { method: 'DELETE' });
        await cargarEnlacesRapidosModal();
    } catch (err) {
        alert("Error al eliminar enlace: " + err.message);
    }
}

function insertarEnlaceEnInput(texto) {
    const input = document.getElementById('input-mensaje-texto');
    if (input) {
        if (input.value && input.value.trim()) {
            input.value = input.value.trim() + '\n' + texto;
        } else {
            input.value = texto;
        }
        input.focus();
    }
    cerrarModalEnlacesRapidos();
}

function insertarEnlacePersonalizado() {
    const descInput = document.getElementById('input-enlace-personalizado-desc');
    const urlInput = document.getElementById('input-enlace-personalizado-url');

    const desc = descInput ? descInput.value.trim() : '';
    const url = urlInput ? urlInput.value.trim() : '';

    if (!url) return alert("Por favor ingresa una URL válida.");

    const texto = desc ? `🔗 *${desc}:* ${url}` : url;
    insertarEnlaceEnInput(texto);

    if (descInput) descInput.value = '';
    if (urlInput) urlInput.value = '';
}

// ------------------------------------------------------------------------------
// RESPUESTAS RÁPIDAS
// ------------------------------------------------------------------------------
async function abrirModalRespuestasRapidas() {
    if (!chatActivoJid) {
        alert("Por favor selecciona una conversación en la lista.");
        return;
    }

    const modal = document.getElementById('modal-respuestas-rapidas');
    if (!modal) return;
    modal.classList.remove('hidden');

    await cargarRespuestasRapidasModal();
}

function cerrarModalRespuestasRapidas() {
    const modal = document.getElementById('modal-respuestas-rapidas');
    if (modal) modal.classList.add('hidden');
}

async function cargarRespuestasRapidasModal() {
    const container = document.getElementById('lista-respuestas-rapidas-container');
    if (!container) return;

    container.innerHTML = `<div class="py-6 text-center text-slate-400 text-xs"><i class="fa-solid fa-circle-notch fa-spin mr-2"></i>Cargando respuestas rápidas...</div>`;

    try {
        const respuestas = await apiFetch('/api/respuestas-rapidas');
        if (!Array.isArray(respuestas) || respuestas.length === 0) {
            container.innerHTML = `<div class="py-6 text-center text-slate-400 text-xs">No hay respuestas rápidas guardadas. Haz clic en "Nueva" para crear una.</div>`;
            return;
        }

        container.innerHTML = respuestas.map(r => `
            <div class="bg-slate-950/60 border border-slate-800 hover:border-slate-700/80 rounded-2xl p-3.5 space-y-2 transition">
                <div class="flex items-center justify-between">
                    <div class="flex items-center space-x-2">
                        <span class="font-bold text-white text-xs">${r.titulo}</span>
                        ${r.atajo ? `<span class="px-2 py-0.5 bg-amber-500/10 text-amber-300 border border-amber-500/30 rounded-lg text-[10px] font-mono">${r.atajo}</span>` : ''}
                    </div>
                    <button onclick="eliminarRespuestaRapida(${r.id})" class="text-slate-500 hover:text-rose-400 text-xs p-1" title="Eliminar plantilla">
                        <i class="fa-solid fa-trash-can"></i>
                    </button>
                </div>
                <p class="text-slate-300 text-xs leading-relaxed whitespace-pre-wrap line-clamp-3 bg-slate-900/60 p-2.5 rounded-xl border border-slate-800/40">${r.contenido}</p>
                <div class="flex items-center justify-end space-x-2 pt-1">
                    <button type="button" onclick="insertarRespuestaRapida('${r.contenido.replace(/'/g, "\\'").replace(/\n/g, "\\n")}')" class="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl text-xs font-semibold flex items-center space-x-1.5 transition">
                        <i class="fa-solid fa-arrow-turn-down text-[10px] text-indigo-400"></i>
                        <span>Pegar en Mensaje</span>
                    </button>
                    <button type="button" onclick="enviarRespuestaRapidaDirecta('${r.contenido.replace(/'/g, "\\'").replace(/\n/g, "\\n")}')" class="px-3.5 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-bold flex items-center space-x-1.5 transition shadow-sm">
                        <i class="fa-solid fa-paper-plane text-[10px]"></i>
                        <span>Enviar Ahora</span>
                    </button>
                </div>
            </div>
        `).join('');
    } catch (err) {
        container.innerHTML = `<div class="py-6 text-center text-rose-400 text-xs">Error al cargar respuestas: ${err.message}</div>`;
    }
}

function insertarRespuestaRapida(contenido) {
    const input = document.getElementById('input-mensaje-texto');
    if (input) {
        if (input.value && input.value.trim()) {
            input.value = input.value.trim() + '\n\n' + contenido;
        } else {
            input.value = contenido;
        }
        input.focus();
    }
    cerrarModalRespuestasRapidas();
}

async function enviarRespuestaRapidaDirecta(contenido) {
    if (!chatActivoJid) return alert("Selecciona una conversación en la lista.");
    const confirma = confirm(`¿Deseas enviar este mensaje por WhatsApp de inmediato al cliente?\n\n"${contenido.substring(0, 80)}..."`);
    if (!confirma) return;

    try {
        await apiFetch(`/api/conversaciones/${encodeURIComponent(chatActivoJid)}/enviar`, {
            method: 'POST',
            body: JSON.stringify({ texto: contenido })
        });
        cerrarModalRespuestasRapidas();
        const nomElem = document.getElementById('chat-nombre-cliente');
        seleccionarChat(chatActivoJid, nomElem ? nomElem.textContent : '');
    } catch (err) {
        alert("Error al enviar respuesta rápida: " + err.message);
    }
}

function abrirModalCrearRespuestaRapida() {
    const modal = document.getElementById('modal-crear-respuesta-rapida');
    if (modal) {
        document.getElementById('input-resp-titulo').value = '';
        document.getElementById('input-resp-atajo').value = '';
        document.getElementById('input-resp-contenido').value = '';
        modal.classList.remove('hidden');
    }
}

function cerrarModalCrearRespuestaRapida() {
    const modal = document.getElementById('modal-crear-respuesta-rapida');
    if (modal) modal.classList.add('hidden');
}

async function guardarNuevaRespuestaRapida(event) {
    event.preventDefault();
    const titulo = document.getElementById('input-resp-titulo')?.value?.trim();
    const atajo = document.getElementById('input-resp-atajo')?.value?.trim();
    const contenido = document.getElementById('input-resp-contenido')?.value?.trim();

    if (!titulo || !contenido) return alert("El título y contenido son obligatorios.");

    try {
        await apiFetch('/api/respuestas-rapidas', {
            method: 'POST',
            body: JSON.stringify({ titulo, atajo, contenido })
        });

        cerrarModalCrearRespuestaRapida();
        await cargarRespuestasRapidasModal();
    } catch (err) {
        alert("Error al guardar respuesta rápida: " + err.message);
    }
}

async function eliminarRespuestaRapida(id) {
    if (!confirm("¿Deseas eliminar esta plantilla de respuesta rápida?")) return;
    try {
        await apiFetch(`/api/respuestas-rapidas/${id}`, { method: 'DELETE' });
        await cargarRespuestasRapidasModal();
    } catch (err) {
        alert("Error al eliminar: " + err.message);
    }
}


