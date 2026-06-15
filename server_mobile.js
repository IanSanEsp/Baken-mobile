'use strict';
const express = require('express');
const mysql   = require('mysql2/promise');
const cors    = require('cors');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
require('dotenv').config();

const app        = express();
const PORT       = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'bdsm_cecyt9_secret_2026';

app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/', (_req, res) => res.sendStatus(200));

// ── Pool MySQL (Railway) ──────────────────────────────────────────────────────
let pool;
async function connectDB() {
    pool = mysql.createPool({
        host:               process.env.DB_HOST     || 'yamabiko.proxy.rlwy.net',
        user:               process.env.DB_USER     || 'root',
        password:           process.env.DB_PASSWORD || 'hdFfITZienJPkyyohBLiETNwDmRwSjgJ',
        database:           process.env.DB_NAME     || 'railway',
        port:               parseInt(process.env.DB_PORT || '28452'),
        waitForConnections: true,
        connectionLimit:    10,
        connectTimeout:     30000,
    });
    const c = await pool.getConnection();
    console.log(`Conectado → ${process.env.DB_HOST || 'yamabiko.proxy.rlwy.net'}/railway`);
    c.release();
}

// ── Hora México (UTC-6 fijo) ──────────────────────────────────────────────────
function mexNow() {
    // Subtrae 6 h al timestamp UTC → tiempo local de México
    return new Date(Date.now() - 6 * 3600 * 1000);
}
function hoyMX()  { return mexNow().toISOString().slice(0, 10); }
function horaMX() { return mexNow().toISOString().slice(11, 19); } // HH:MM:SS
function diaMX()  {
    return ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'][mexNow().getUTCDay()];
}

// ── Middleware de autenticación ───────────────────────────────────────────────
function requireAuth(req, res, next) {
    const auth = req.headers['authorization'];
    if (!auth || !auth.startsWith('Bearer '))
        return res.status(401).json({ success: false, message: 'Token requerido' });
    try {
        req.usuario = jwt.verify(auth.slice(7), JWT_SECRET);
        next();
    } catch {
        res.status(401).json({ success: false, message: 'Token inválido o expirado' });
    }
}

// ── Recalcular estados de salones ─────────────────────────────────────────────
// Actualiza la columna `estado` de Salones considerando Horario_Dinamico.
// Se llama antes de endpoints que devuelven disponibilidad de salones.
let _lastRecalc = 0;
async function recalcularEstadosSalones() {
    const now = Date.now();
    if (now - _lastRecalc < 60_000) return; // máximo 1 vez por minuto
    _lastRecalc = now;

    const fecha = hoyMX();
    const hora  = horaMX();
    const dia   = diaMX();
    const conn  = await pool.getConnection();
    try {
        // 1. Todo a Disponible excepto En Mantenimiento
        await conn.execute(
            `UPDATE Salones SET estado = 'Disponible' WHERE estado NOT IN ('En Mantenimiento')`
        );
        // 2. Ocupado por Horario_Fijo sin override dinámico de hoy
        await conn.execute(
            `UPDATE Salones s
             INNER JOIN Horario_Fijo hf ON hf.id_salon = s.id_salon
             SET s.estado = 'Ocupado'
             WHERE hf.dia = ?
               AND hf.hora_inicio <= ? AND hf.hora_fin > ?
               AND NOT EXISTS (
                   SELECT 1 FROM Horario_Dinamico hd
                   WHERE hd.id_horario_fijo_detalle = hf.id_horario_fijo_detalle
                     AND hd.fecha = ?
               )`,
            [dia, hora, hora, fecha]
        );
        // 3. Provisional / Ocupado por Horario_Dinamico de hoy
        //    - Reasignación de salón  → Provisional  (el nuevo salón recibe la clase)
        //    - Adelanto de clase       → Ocupado      (clase en nuevo horario/salón)
        await conn.execute(
            `UPDATE Salones s
             INNER JOIN Horario_Dinamico hd ON hd.id_salon_temporal = s.id_salon
             SET s.estado = CASE
                 WHEN hd.motivo_cambio = 'Reasignación de salón' THEN 'Provisional'
                 ELSE 'Ocupado'
             END
             WHERE hd.fecha = ?
               AND hd.hora_inicio <= ? AND hd.hora_fin > ?`,
            [fecha, hora, hora]
        );
    } finally {
        conn.release();
    }
}

// ── Comparar contraseña (bcrypt o texto plano) ────────────────────────────────
async function checkPassword(plain, hash) {
    if (!hash) return false;
    if (hash.startsWith('$2a$') || hash.startsWith('$2b$') || hash.startsWith('$2y$')) {
        const fixed = hash.startsWith('$2y$') ? '$2b$' + hash.slice(4) : hash;
        return bcrypt.compare(plain, fixed);
    }
    return plain === hash;
}

// ══════════════════════════════════════════════════════════════════════════════
//  AUTH
// ══════════════════════════════════════════════════════════════════════════════

// Login Alumno (sin JWT — devuelve objeto usuario directamente)
app.post('/api/login', async (req, res) => {
    const { correo, contrasena } = req.body;
    if (!correo || !contrasena)
        return res.status(400).json({ success: false, message: 'Faltan credenciales' });
    try {
        const [rows] = await pool.execute(
            `SELECT u.id_usuarios AS boleta, u.nombre, u.correo, u.turno, u.contraseña,
                    tu.nombre_tipo AS tipo_usuario,
                    g.id_grupo, g.nombre_grupo AS grupo, g.semestre, g.turno AS grupo_turno
             FROM Usuarios u
             INNER JOIN tipo_usuario tu ON tu.id_tipo_usuario = u.tipo_usuario
             LEFT  JOIN Grupos g        ON g.id_grupo = u.id_grupo
             WHERE u.correo = ? AND tu.nombre_tipo = 'Alumno'`,
            [correo]
        );
        if (!rows.length || !(await checkPassword(contrasena, rows[0].contraseña)))
            return res.status(401).json({ success: false, message: 'Correo o contraseña incorrectos' });

        const a = rows[0];
        res.json({ success: true, usuario: {
            id: a.boleta, boleta: a.boleta, nombre: a.nombre, correo: a.correo,
            tipo_usuario: 'Alumno',
            id_grupo: a.id_grupo || null, grupo: a.grupo || 'Sin grupo',
            semestre: a.semestre || 1, turno: a.grupo_turno || 'No asignado',
        }});
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// Login Profesor / Prefecto (devuelve JWT + usuario)
app.post('/api/usuarios/login', async (req, res) => {
    const { correo, contrasena } = req.body;
    if (!correo || !contrasena)
        return res.status(400).json({ success: false, message: 'Faltan credenciales' });
    try {
        const [rows] = await pool.execute(
            `SELECT u.id_usuarios, u.nombre, u.correo, u.turno, u.contraseña,
                    tu.nombre_tipo AS tipo_usuario,
                    g.id_grupo, g.nombre_grupo, g.semestre
             FROM Usuarios u
             INNER JOIN tipo_usuario tu ON tu.id_tipo_usuario = u.tipo_usuario
             LEFT  JOIN Grupos g        ON g.id_grupo = u.id_grupo
             WHERE u.correo = ?
               AND tu.nombre_tipo IN ('Prefecto General','Prefecto de Piso','Profesor','Auxiliar')`,
            [correo]
        );
        if (!rows.length || !(await checkPassword(contrasena, rows[0].contraseña)))
            return res.status(401).json({ success: false, message: 'Credenciales incorrectas' });

        const u = rows[0];
        const token = jwt.sign(
            { id: u.id_usuarios, nombre: u.nombre, tipo: u.tipo_usuario },
            JWT_SECRET, { expiresIn: '12h' }
        );
        res.json({
            success: true,
            token,
            usuario: {
                id: u.id_usuarios, nombre: u.nombre, correo: u.correo, turno: u.turno,
                tipo_usuario: u.tipo_usuario,
                id_grupo: u.id_grupo || null, grupo: u.nombre_grupo || null, semestre: u.semestre || null,
            }
        });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
//  PERFIL
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/alumno/:boleta', async (req, res) => {
    try {
        const [rows] = await pool.execute(
            `SELECT u.id_usuarios AS boleta, u.nombre, u.correo, u.turno,
                    tu.nombre_tipo AS tipo_usuario, u.id_grupo,
                    g.nombre_grupo AS grupo, g.semestre, g.turno AS grupo_turno
             FROM Usuarios u
             INNER JOIN tipo_usuario tu ON tu.id_tipo_usuario = u.tipo_usuario
             LEFT  JOIN Grupos g        ON g.id_grupo = u.id_grupo
             WHERE u.id_usuarios = ?`, [req.params.boleta]
        );
        if (!rows.length) return res.status(404).json({ success: false, message: 'No encontrado' });
        res.json({ success: true, alumno: rows[0] });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
//  HORARIOS (dinámicamente consciente)
// ══════════════════════════════════════════════════════════════════════════════

// ── Horario completo de un grupo ─────────────────────────────────────────────
app.get('/api/horario/grupo/:id_grupo', async (req, res) => {
    try {
        const [rows] = await pool.execute(
            `SELECT hf.id_horario_fijo_detalle, hf.dia, hf.hora_inicio, hf.hora_fin, hf.bloque_horario,
                    hf.id_salon, s.nombre_salon AS numero_salon, s.piso,
                    hf.id_materia, m.nombre_materia AS materia,
                    hf.id_profesor, u.nombre AS profesor_nombre,
                    hor.id_grupo, g.nombre_grupo
             FROM Horario_Fijo hf
             INNER JOIN horarios hor ON hor.id_horario_fijo = hf.id_horario_fijo
             INNER JOIN Grupos g     ON g.id_grupo  = hor.id_grupo
             INNER JOIN Materias m   ON m.id_materia = hf.id_materia
             INNER JOIN Usuarios u   ON u.id_usuarios = hf.id_profesor
             LEFT  JOIN Salones s    ON s.id_salon  = hf.id_salon
             WHERE hor.id_grupo = ?
             ORDER BY FIELD(hf.dia,'Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'), hf.hora_inicio`,
            [req.params.id_grupo]
        );
        res.json({ success: true, horario: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── Horario de hoy de un grupo ────────────────────────────────────────────────
app.get('/api/horario/grupo/:id_grupo/hoy', async (req, res) => {
    const fecha = hoyMX();
    const dia   = diaMX();
    try {
        // Horario fijo de hoy (sin override)
        const [fijo] = await pool.execute(
            `SELECT hf.id_horario_fijo_detalle, hf.dia, hf.hora_inicio, hf.hora_fin, hf.bloque_horario,
                    hf.id_salon, s.nombre_salon AS numero_salon, s.piso,
                    hf.id_materia, m.nombre_materia AS materia,
                    hf.id_profesor, u.nombre AS profesor_nombre,
                    hor.id_grupo, g.nombre_grupo, NULL AS motivo_cambio
             FROM Horario_Fijo hf
             INNER JOIN horarios hor ON hor.id_horario_fijo = hf.id_horario_fijo
             INNER JOIN Grupos g     ON g.id_grupo  = hor.id_grupo
             INNER JOIN Materias m   ON m.id_materia = hf.id_materia
             INNER JOIN Usuarios u   ON u.id_usuarios = hf.id_profesor
             LEFT  JOIN Salones s    ON s.id_salon  = hf.id_salon
             WHERE hor.id_grupo = ? AND hf.dia = ?
               AND NOT EXISTS (
                   SELECT 1 FROM Horario_Dinamico hd
                   WHERE hd.id_horario_fijo_detalle = hf.id_horario_fijo_detalle AND hd.fecha = ?
               )
             ORDER BY hf.hora_inicio`,
            [req.params.id_grupo, dia, fecha]
        );
        // Overrides dinámicos de hoy para el grupo
        const [dinamico] = await pool.execute(
            `SELECT hf.id_horario_fijo_detalle, hf.dia,
                    hd.hora_inicio, hd.hora_fin, hd.bloque_horario,
                    hd.id_salon_temporal AS id_salon, s.nombre_salon AS numero_salon, s.piso,
                    hf.id_materia, m.nombre_materia AS materia,
                    hf.id_profesor, u.nombre AS profesor_nombre,
                    hor.id_grupo, g.nombre_grupo, hd.motivo_cambio
             FROM Horario_Dinamico hd
             INNER JOIN Horario_Fijo hf ON hf.id_horario_fijo_detalle = hd.id_horario_fijo_detalle
             INNER JOIN horarios hor    ON hor.id_horario_fijo = hf.id_horario_fijo
             INNER JOIN Grupos g        ON g.id_grupo  = hor.id_grupo
             INNER JOIN Materias m      ON m.id_materia = hf.id_materia
             INNER JOIN Usuarios u      ON u.id_usuarios = hf.id_profesor
             LEFT  JOIN Salones s       ON s.id_salon = hd.id_salon_temporal
             WHERE hor.id_grupo = ? AND hd.fecha = ?
             ORDER BY hd.hora_inicio`,
            [req.params.id_grupo, fecha]
        );
        const horario = [...fijo, ...dinamico].sort((a, b) =>
            (a.hora_inicio || '').localeCompare(b.hora_inicio || '')
        );
        res.json({ success: true, horario });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── Clase activa ahora en un salón (considera Horario_Dinamico) ───────────────
app.get('/api/horario/salon/:id_salon', async (req, res) => {
    const fecha = hoyMX();
    const hora  = horaMX();
    const dia   = diaMX();
    const id    = req.params.id_salon;
    try {
        // 1. Clases movidas dinámicamente A este salón hoy
        const [dyn] = await pool.execute(
            `SELECT hf.id_horario_fijo_detalle,
                    hd.hora_inicio, hd.hora_fin, hd.bloque_horario,
                    hd.id_salon_temporal AS id_salon, s.nombre_salon AS numero_salon, s.piso,
                    hf.id_materia, m.nombre_materia AS materia,
                    hf.id_profesor, u.nombre AS profesor_nombre,
                    hor.id_grupo, g.nombre_grupo, hd.motivo_cambio
             FROM Horario_Dinamico hd
             INNER JOIN Horario_Fijo hf ON hf.id_horario_fijo_detalle = hd.id_horario_fijo_detalle
             INNER JOIN horarios hor    ON hor.id_horario_fijo = hf.id_horario_fijo
             INNER JOIN Grupos g        ON g.id_grupo  = hor.id_grupo
             INNER JOIN Materias m      ON m.id_materia = hf.id_materia
             INNER JOIN Usuarios u      ON u.id_usuarios = hf.id_profesor
             INNER JOIN Salones s       ON s.id_salon = hd.id_salon_temporal
             WHERE hd.id_salon_temporal = ? AND hd.fecha = ?
               AND hd.hora_inicio <= ? AND hd.hora_fin > ?
             LIMIT 1`,
            [id, fecha, hora, hora]
        );
        if (dyn.length) return res.json({ success: true, horario: dyn });

        // 2. Clase fija en este salón sin override hoy
        const [fijo] = await pool.execute(
            `SELECT hf.id_horario_fijo_detalle,
                    hf.hora_inicio, hf.hora_fin, hf.bloque_horario,
                    hf.id_salon, s.nombre_salon AS numero_salon, s.piso,
                    hf.id_materia, m.nombre_materia AS materia,
                    hf.id_profesor, u.nombre AS profesor_nombre,
                    hor.id_grupo, g.nombre_grupo, NULL AS motivo_cambio
             FROM Horario_Fijo hf
             INNER JOIN horarios hor ON hor.id_horario_fijo = hf.id_horario_fijo
             INNER JOIN Grupos g     ON g.id_grupo  = hor.id_grupo
             INNER JOIN Materias m   ON m.id_materia = hf.id_materia
             INNER JOIN Usuarios u   ON u.id_usuarios = hf.id_profesor
             LEFT  JOIN Salones s    ON s.id_salon  = hf.id_salon
             WHERE hf.id_salon = ? AND hf.dia = ?
               AND hf.hora_inicio <= ? AND hf.hora_fin > ?
               AND NOT EXISTS (
                   SELECT 1 FROM Horario_Dinamico hd
                   WHERE hd.id_horario_fijo_detalle = hf.id_horario_fijo_detalle AND hd.fecha = ?
               )
             LIMIT 1`,
            [id, dia, hora, hora, fecha]
        );
        res.json({ success: true, horario: fijo });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── Horario semanal completo de un salón ──────────────────────────────────────
app.get('/api/horario/salon/:id_salon/semana', async (req, res) => {
    try {
        const [rows] = await pool.execute(
            `SELECT hf.id_horario_fijo_detalle, hf.dia, hf.hora_inicio, hf.hora_fin, hf.bloque_horario,
                    hf.id_salon, s.nombre_salon AS numero_salon, s.piso,
                    hf.id_materia, m.nombre_materia AS materia,
                    hf.id_profesor, u.nombre AS profesor_nombre,
                    hor.id_grupo, g.nombre_grupo
             FROM Horario_Fijo hf
             INNER JOIN horarios hor ON hor.id_horario_fijo = hf.id_horario_fijo
             INNER JOIN Grupos g     ON g.id_grupo  = hor.id_grupo
             INNER JOIN Materias m   ON m.id_materia = hf.id_materia
             INNER JOIN Usuarios u   ON u.id_usuarios = hf.id_profesor
             LEFT  JOIN Salones s    ON s.id_salon  = hf.id_salon
             WHERE hf.id_salon = ?
             ORDER BY FIELD(hf.dia,'Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'), hf.hora_inicio`,
            [req.params.id_salon]
        );
        res.json({ success: true, horario: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── Horario completo del profesor (con overrides dinámicos de hoy) ─────────────
app.get('/api/horario/profesor/:id_profesor', async (req, res) => {
    const fecha = hoyMX();
    const id    = req.params.id_profesor;
    try {
        // Horario fijo base
        const [fijo] = await pool.execute(
            `SELECT hf.id_horario_fijo_detalle, hf.dia, hf.hora_inicio, hf.hora_fin, hf.bloque_horario,
                    hf.id_salon, s.nombre_salon AS numero_salon, s.piso,
                    hf.id_materia, m.nombre_materia AS materia,
                    hor.id_grupo, g.nombre_grupo
             FROM Horario_Fijo hf
             INNER JOIN horarios hor ON hor.id_horario_fijo = hf.id_horario_fijo
             INNER JOIN Grupos g     ON g.id_grupo  = hor.id_grupo
             INNER JOIN Materias m   ON m.id_materia = hf.id_materia
             LEFT  JOIN Salones s    ON s.id_salon  = hf.id_salon
             WHERE hf.id_profesor = ?
             ORDER BY FIELD(hf.dia,'Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'), hf.hora_inicio`,
            [id]
        );
        // Overrides de hoy para este profesor
        const [dyn] = await pool.execute(
            `SELECT hd.id_horario_fijo_detalle,
                    hd.hora_inicio, hd.hora_fin, hd.bloque_horario,
                    hd.id_salon_temporal AS id_salon, s.nombre_salon AS numero_salon, s.piso,
                    hd.motivo_cambio
             FROM Horario_Dinamico hd
             INNER JOIN Horario_Fijo hf ON hf.id_horario_fijo_detalle = hd.id_horario_fijo_detalle
             LEFT  JOIN Salones s       ON s.id_salon = hd.id_salon_temporal
             WHERE hf.id_profesor = ? AND hd.fecha = ?`,
            [id, fecha]
        );
        // Mapa de overrides: id_horario_fijo_detalle → override
        const ovMap = new Map(dyn.map(d => [d.id_horario_fijo_detalle, d]));
        const diaHoy = diaMX();

        const horario = fijo.map(r => {
            const ov = ovMap.get(r.id_horario_fijo_detalle);
            // Solo aplicar override en entradas cuyo día es hoy
            if (ov && r.dia === diaHoy) {
                return {
                    ...r,
                    hora_inicio:    ov.hora_inicio,
                    hora_fin:       ov.hora_fin,
                    bloque_horario: ov.bloque_horario,
                    id_salon:       ov.id_salon,
                    numero_salon:   ov.numero_salon,
                    piso:           ov.piso,
                    motivo_cambio:  ov.motivo_cambio,
                };
            }
            return { ...r, motivo_cambio: null };
        });

        res.json({ success: true, horario });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
//  SALONES
// ══════════════════════════════════════════════════════════════════════════════

// Buscar salones (recalcula estados antes de devolver)
app.post('/api/salones/buscar', async (req, res) => {
    const { nombre = '', piso = '', disponibilidad = '', tipo = '' } = req.body;
    try {
        await recalcularEstadosSalones();

        let q = `SELECT s.id_salon, s.nombre_salon AS numero_salon, s.piso,
                        ts.nombre_tipo_salon AS tipo, s.estado
                 FROM Salones s
                 LEFT JOIN tipo_salon ts ON ts.id_tipo_salon = s.tipo_salon
                 WHERE 1=1`;
        const p = [];
        if (nombre)        { q += ' AND s.nombre_salon LIKE ?'; p.push(`%${nombre}%`); }
        if (piso !== '')   { q += ' AND s.piso = ?';            p.push(parseInt(piso)); }
        if (disponibilidad){ q += ' AND s.estado = ?';          p.push(disponibilidad); }
        if (tipo)          { q += ' AND ts.nombre_tipo_salon LIKE ?'; p.push(`%${tipo}%`); }
        q += ' ORDER BY s.piso, s.nombre_salon LIMIT 100';

        const [rows] = await pool.execute(q, p);
        res.json({ success: true, salones: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
//  FAVORITOS — SALONES
// ══════════════════════════════════════════════════════════════════════════════

app.post('/api/favoritos/salon', async (req, res) => {
    const { boleta, id_salon } = req.body;
    if (!boleta || !id_salon)
        return res.status(400).json({ success: false, message: 'Faltan datos' });
    try {
        await pool.execute(
            `INSERT INTO Salones_Favoritos (id_usuario, id_salon, mostrar_inicio)
             VALUES (?, ?, TRUE)
             ON DUPLICATE KEY UPDATE fecha_agregado = CURRENT_TIMESTAMP`,
            [boleta, id_salon]
        );
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.get('/api/favoritos/salon/:boleta', async (req, res) => {
    try {
        await recalcularEstadosSalones();
        const [rows] = await pool.execute(
            `SELECT s.id_salon, s.nombre_salon AS numero_salon, s.piso,
                    ts.nombre_tipo_salon AS tipo, s.estado, sf.mostrar_inicio
             FROM Salones_Favoritos sf
             INNER JOIN Salones s     ON s.id_salon       = sf.id_salon
             LEFT  JOIN tipo_salon ts ON ts.id_tipo_salon = s.tipo_salon
             WHERE sf.id_usuario = ?
             ORDER BY sf.fecha_agregado DESC`,
            [req.params.boleta]
        );
        res.json({ success: true, favoritos: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.delete('/api/favoritos/salon/:boleta/:id_salon', async (req, res) => {
    try {
        const [r] = await pool.execute(
            `DELETE FROM Salones_Favoritos WHERE id_usuario = ? AND id_salon = ?`,
            [req.params.boleta, req.params.id_salon]
        );
        if (!r.affectedRows) return res.status(404).json({ success: false, message: 'No encontrado' });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.put('/api/favoritos/salon/mostrar', async (req, res) => {
    const { boleta, id_salon, mostrar_inicio } = req.body;
    try {
        await pool.execute(
            `UPDATE Salones_Favoritos SET mostrar_inicio = ? WHERE id_usuario = ? AND id_salon = ?`,
            [mostrar_inicio, boleta, id_salon]
        );
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
//  FAVORITOS — GRUPOS
// ══════════════════════════════════════════════════════════════════════════════

app.post('/api/favoritos/grupo', async (req, res) => {
    const { boleta, id_grupo } = req.body;
    if (!boleta || !id_grupo)
        return res.status(400).json({ success: false, message: 'Faltan datos' });
    try {
        await pool.execute(
            `INSERT INTO Grupos_Favoritos (id_usuario, id_grupo, mostrar_inicio)
             VALUES (?, ?, TRUE)
             ON DUPLICATE KEY UPDATE fecha_agregado = CURRENT_TIMESTAMP`,
            [boleta, id_grupo]
        );
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.get('/api/favoritos/grupo/:boleta', async (req, res) => {
    try {
        const [rows] = await pool.execute(
            `SELECT g.id_grupo, g.nombre_grupo, g.semestre, g.turno, gf.mostrar_inicio
             FROM Grupos_Favoritos gf
             INNER JOIN Grupos g ON g.id_grupo = gf.id_grupo
             WHERE gf.id_usuario = ?
             ORDER BY gf.fecha_agregado DESC`,
            [req.params.boleta]
        );
        res.json({ success: true, favoritos: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.delete('/api/favoritos/grupo/:boleta/:id_grupo', async (req, res) => {
    try {
        const [r] = await pool.execute(
            `DELETE FROM Grupos_Favoritos WHERE id_usuario = ? AND id_grupo = ?`,
            [req.params.boleta, req.params.id_grupo]
        );
        if (!r.affectedRows) return res.status(404).json({ success: false, message: 'No encontrado' });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.put('/api/favoritos/grupo/mostrar', async (req, res) => {
    const { boleta, id_grupo, mostrar_inicio } = req.body;
    try {
        await pool.execute(
            `UPDATE Grupos_Favoritos SET mostrar_inicio = ? WHERE id_usuario = ? AND id_grupo = ?`,
            [mostrar_inicio, boleta, id_grupo]
        );
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
//  INICIO — favoritos con estados actualizados
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/inicio/favoritos/:boleta', async (req, res) => {
    try {
        await recalcularEstadosSalones();
        const [salones] = await pool.execute(
            `SELECT s.id_salon, s.nombre_salon AS numero_salon, s.piso,
                    ts.nombre_tipo_salon AS tipo, s.estado, sf.mostrar_inicio
             FROM Salones_Favoritos sf
             INNER JOIN Salones s     ON s.id_salon       = sf.id_salon
             LEFT  JOIN tipo_salon ts ON ts.id_tipo_salon = s.tipo_salon
             WHERE sf.id_usuario = ? AND sf.mostrar_inicio = TRUE
             ORDER BY sf.fecha_agregado`,
            [req.params.boleta]
        );
        const [grupos] = await pool.execute(
            `SELECT g.id_grupo, g.nombre_grupo, g.semestre, g.turno, gf.mostrar_inicio
             FROM Grupos_Favoritos gf
             INNER JOIN Grupos g ON g.id_grupo = gf.id_grupo
             WHERE gf.id_usuario = ? AND gf.mostrar_inicio = TRUE
             ORDER BY gf.fecha_agregado`,
            [req.params.boleta]
        );
        res.json({ success: true, salones, grupos });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
//  HEALTH CHECK
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/health', (_, res) => res.json({ status: 'ok', time: hoyMX() + ' ' + horaMX() }));

// ══════════════════════════════════════════════════════════════════════════════
//  START
// ══════════════════════════════════════════════════════════════════════════════

connectDB().then(() => {
    app.listen(PORT, () => console.log(`Server mobile → http://localhost:${PORT}`));
}).catch(e => {
    console.error('No se pudo conectar a la BD:', e.message);
    process.exit(1);
});
