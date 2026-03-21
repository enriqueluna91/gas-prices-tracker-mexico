"""
cne_precios.py
--------------
Pulls daily gas/diesel prices from CNE (Comisión Nacional de Energía)
API: api-reportediario.cne.gob.mx

Usage:
    python cne_precios.py

Stores results in cne_precios.db (SQLite) with timestamp.
Schedule via cron:  0 7 * * * /usr/bin/python3 /path/to/cne_precios.py
"""

import argparse
import requests
import sqlite3
import time
import logging
import xml.etree.ElementTree as ET
from datetime import datetime, date

# ── Config ────────────────────────────────────────────────────────────────────

CATALOGO_BASE   = "https://api-catalogo.cne.gob.mx"
REPORTE_BASE    = "https://api-reportediario.cne.gob.mx"
GEOREF_URL      = "https://publicacionexterna.azurewebsites.net/publicaciones/places"
DB_PATH         = "cne_precios.db"
SLEEP_BETWEEN   = 0.3   # seconds between requests — be polite to the API
TIMEOUT         = 15    # request timeout in seconds

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s"
)
log = logging.getLogger(__name__)

# ── Database ──────────────────────────────────────────────────────────────────

def init_db(conn):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS precios (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            fecha           TEXT NOT NULL,
            numero          TEXT,
            nombre          TEXT,
            direccion       TEXT,
            producto        TEXT,
            sub_producto    TEXT,
            precio          REAL,
            entidad_id      TEXT,
            municipio_id    TEXT,
            created_at      TEXT DEFAULT (datetime('now'))
        )
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_fecha ON precios(fecha)
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS georef (
            place_id    TEXT PRIMARY KEY,
            name        TEXT,
            cre_id      TEXT UNIQUE,
            longitude   REAL,
            latitude    REAL,
            fetched_at  TEXT DEFAULT (datetime('now'))
        )
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_georef_cre_id ON georef(cre_id)
    """)
    conn.commit()

# ── API helpers ───────────────────────────────────────────────────────────────

def get_json(url, params=None):
    try:
        r = requests.get(url, params=params, timeout=TIMEOUT)
        r.raise_for_status()
        data = r.json()
        if isinstance(data, dict) and not data.get("Success", True):
            return []
        if isinstance(data, dict) and "Value" in data:
            return data["Value"] or []
        return data
    except Exception as e:
        log.warning(f"Request failed: {url} | {e}")
        return []

def get_estados():
    """Fetch all estados (entidades federativas)."""
    data = get_json(f"{CATALOGO_BASE}/api/utiles/entidadesfederativas")
    if data:
        log.info(f"{len(data)} estados loaded")
    else:
        log.error("Could not fetch estados from /api/utiles/entidadesfederativas")
    return data

def get_municipios(entidad_id):
    """Fetch municipalities for a given estado. entidad_id must be zero-padded (e.g. '03')."""
    return get_json(
        f"{CATALOGO_BASE}/api/utiles/municipios",
        params={"EntidadFederativaId": str(entidad_id).zfill(2)},
    )

def get_precios(entidad_id, municipio_id):
    """Fetch current fuel prices for a estado+municipio combo."""
    return get_json(
        f"{REPORTE_BASE}/api/EstacionServicio/Petroliferos",
        params={
            "entidadId": str(entidad_id).zfill(2),
            "municipioId": str(municipio_id).zfill(3),
        },
    )

# ── Georeference ─────────────────────────────────────────────────────────────

def fetch_georef(conn):
    """Download CRE places XML and upsert station coordinates into georef table."""
    log.info(f"Fetching georeference data from {GEOREF_URL} ...")
    try:
        r = requests.get(GEOREF_URL, timeout=60)
        r.raise_for_status()
    except Exception as e:
        log.error(f"Failed to fetch georef XML: {e}")
        return 0

    root = ET.fromstring(r.content)
    batch = []
    for place in root.iter("place"):
        place_id = place.get("place_id")
        name = place.findtext("name")
        cre_id = place.findtext("cre_id")
        loc = place.find("location")
        lon = float(loc.findtext("x")) if loc is not None and loc.findtext("x") else None
        lat = float(loc.findtext("y")) if loc is not None and loc.findtext("y") else None
        batch.append((place_id, name, cre_id, lon, lat))

    conn.executemany("""
        INSERT OR REPLACE INTO georef (place_id, name, cre_id, longitude, latitude, fetched_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
    """, batch)
    conn.commit()
    log.info(f"Georef: {len(batch)} stations upserted.")
    return len(batch)

# ── Main ──────────────────────────────────────────────────────────────────────

def _insert_batch(conn, batch):
    conn.executemany("""
        INSERT INTO precios
            (fecha, numero, nombre, direccion, producto,
             sub_producto, precio, entidad_id, municipio_id)
        VALUES (?,?,?,?,?,?,?,?,?)
    """, batch)
    conn.commit()

def run(test_mode=False):
    today = date.today().isoformat()
    conn = sqlite3.connect(DB_PATH)
    init_db(conn)

    existing = conn.execute(
        "SELECT COUNT(*) FROM precios WHERE fecha = ?", (today,)
    ).fetchone()[0]
    if existing:
        log.info(f"Already have {existing} records for {today}. Skipping.")
        conn.close()
        return

    estados = get_estados()
    if not estados:
        log.error("No estados returned. Exiting.")
        conn.close()
        return

    if test_mode:
        estados = [e for e in estados if e["EntidadFederativaId"] == "03"]
        log.info("TEST MODE: limiting to Baja California Sur (03)")

    total_records = 0
    batch = []

    for estado in estados:
        entidad_id = estado["EntidadFederativaId"]
        entidad_nombre = estado.get("Nombre", entidad_id)

        municipios = get_municipios(entidad_id)
        log.info(f"Estado: {entidad_nombre} ({entidad_id}) | {len(municipios)} municipios")
        time.sleep(SLEEP_BETWEEN)

        for mun in municipios:
            mun_id = mun["MunicipioId"]

            precios = get_precios(entidad_id, mun_id)
            time.sleep(SLEEP_BETWEEN)

            for p in precios:
                batch.append((
                    today,
                    p.get("Numero"),
                    p.get("Nombre"),
                    p.get("Direccion"),
                    p.get("Producto"),
                    p.get("SubProducto"),
                    p.get("PrecioVigente"),
                    str(entidad_id),
                    str(mun_id),
                ))

            if len(batch) >= 500:
                _insert_batch(conn, batch)
                total_records += len(batch)
                log.info(f"  Saved batch — total so far: {total_records}")
                batch = []

    if batch:
        _insert_batch(conn, batch)
        total_records += len(batch)

    log.info(f"Done. {total_records} records saved for {today}.")
    conn.close()

# ── Quick query helper ────────────────────────────────────────────────────────

def query_example():
    """Run this to see today's cheapest Magna prices with coordinates."""
    conn = sqlite3.connect(DB_PATH)
    today = date.today().isoformat()
    rows = conn.execute("""
        SELECT p.nombre, p.direccion, p.precio,
               p.entidad_id, p.municipio_id,
               g.latitude, g.longitude
        FROM precios p
        LEFT JOIN georef g ON g.cre_id = p.numero
        WHERE p.fecha = ?
          AND p.sub_producto LIKE '%Regular%'
        ORDER BY p.precio ASC
        LIMIT 20
    """, (today,)).fetchall()
    conn.close()
    print(f"\n{'='*80}")
    print(f"Top 20 cheapest Magna (Regular) — {today}")
    print(f"{'='*80}")
    for r in rows:
        lat, lon = r[5], r[6]
        coords = f"({lat:.5f}, {lon:.5f})" if lat and lon else "(no coords)"
        print(f"  {r[2]:6.2f} MXN | {r[0]:<40s} | {r[1]:<30s} | {coords}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Pull CNE fuel prices into SQLite")
    parser.add_argument("--test", action="store_true",
                        help="Test mode: only pull Baja California Sur (entidad 03)")
    parser.add_argument("--georef", action="store_true",
                        help="Fetch/refresh CRE georeference data (station coordinates)")
    args = parser.parse_args()

    if args.georef:
        conn = sqlite3.connect(DB_PATH)
        init_db(conn)
        fetch_georef(conn)
        conn.close()
    else:
        run(test_mode=args.test)
        query_example()
