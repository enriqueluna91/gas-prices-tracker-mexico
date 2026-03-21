"""
export_prices.py
----------------
Reads cne_precios.db and exports state-level price aggregates
as a static JSON file for the frontend choropleth map.

Usage:
    python export_prices.py                          # default paths
    python export_prices.py --db path/to/db --out site/data/prices.json
"""

import argparse
import json
import sqlite3
import os
from datetime import date

INEGI_TO_ISO = {
    "01": {"iso": "MX-AGU", "name": "Aguascalientes"},
    "02": {"iso": "MX-BCN", "name": "Baja California"},
    "03": {"iso": "MX-BCS", "name": "Baja California Sur"},
    "04": {"iso": "MX-CAM", "name": "Campeche"},
    "05": {"iso": "MX-COA", "name": "Coahuila"},
    "06": {"iso": "MX-COL", "name": "Colima"},
    "07": {"iso": "MX-CHP", "name": "Chiapas"},
    "08": {"iso": "MX-CHH", "name": "Chihuahua"},
    "09": {"iso": "MX-CMX", "name": "Ciudad de México"},
    "10": {"iso": "MX-DUR", "name": "Durango"},
    "11": {"iso": "MX-GUA", "name": "Guanajuato"},
    "12": {"iso": "MX-GRO", "name": "Guerrero"},
    "13": {"iso": "MX-HID", "name": "Hidalgo"},
    "14": {"iso": "MX-JAL", "name": "Jalisco"},
    "15": {"iso": "MX-MEX", "name": "Estado de México"},
    "16": {"iso": "MX-MIC", "name": "Michoacán"},
    "17": {"iso": "MX-MOR", "name": "Morelos"},
    "18": {"iso": "MX-NAY", "name": "Nayarit"},
    "19": {"iso": "MX-NLE", "name": "Nuevo León"},
    "20": {"iso": "MX-OAX", "name": "Oaxaca"},
    "21": {"iso": "MX-PUE", "name": "Puebla"},
    "22": {"iso": "MX-QUE", "name": "Querétaro"},
    "23": {"iso": "MX-ROO", "name": "Quintana Roo"},
    "24": {"iso": "MX-SLP", "name": "San Luis Potosí"},
    "25": {"iso": "MX-SIN", "name": "Sinaloa"},
    "26": {"iso": "MX-SON", "name": "Sonora"},
    "27": {"iso": "MX-TAB", "name": "Tabasco"},
    "28": {"iso": "MX-TAM", "name": "Tamaulipas"},
    "29": {"iso": "MX-TLA", "name": "Tlaxcala"},
    "30": {"iso": "MX-VER", "name": "Veracruz"},
    "31": {"iso": "MX-YUC", "name": "Yucatán"},
    "32": {"iso": "MX-ZAC", "name": "Zacatecas"},
}

FUEL_CATEGORIES = {
    "regular": "Regular",
    "premium": "Premium",
    "diesel": "Diésel",
}


def classify_fuel(sub_producto: str) -> str | None:
    low = sub_producto.lower().strip()
    if "regular" in low:
        return "regular"
    if "premium" in low:
        return "premium"
    if "diésel" in low or "diesel" in low:
        return "diesel"
    return None


def get_latest_date(conn):
    row = conn.execute("SELECT MAX(fecha) FROM precios").fetchone()
    return row[0] if row else None


def export_states(conn, latest_date: str, out_path: str):
    rows = conn.execute("""
        SELECT entidad_id, sub_producto, precio
        FROM precios
        WHERE fecha = ?
          AND precio IS NOT NULL
          AND precio > 0
    """, (latest_date,)).fetchall()

    buckets: dict[str, dict[str, list[float]]] = {}
    for entidad_id, sub_producto, precio in rows:
        eid = str(entidad_id).zfill(2)
        fuel = classify_fuel(sub_producto)
        if fuel is None:
            continue
        buckets.setdefault(eid, {}).setdefault(fuel, []).append(precio)

    states = {}
    for eid, mapping in INEGI_TO_ISO.items():
        state_data = {
            "name": mapping["name"],
            "entidad_id": eid,
        }
        for fuel_key, fuel_label in FUEL_CATEGORIES.items():
            prices = buckets.get(eid, {}).get(fuel_key, [])
            if prices:
                state_data[fuel_key] = {
                    "avg": round(sum(prices) / len(prices), 2),
                    "min": round(min(prices), 2),
                    "max": round(max(prices), 2),
                    "stations": len(prices),
                }
            else:
                state_data[fuel_key] = None

        states[mapping["iso"]] = state_data

    output = {
        "date": latest_date,
        "generated_at": date.today().isoformat(),
        "states": states,
    }

    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    total_stations = sum(
        s[fuel]["stations"]
        for s in states.values()
        for fuel in ("regular", "premium", "diesel")
        if s.get(fuel)
    )
    print(f"States: {len(states)} states, {total_stations} station-fuel records for {latest_date}")
    print(f"  -> {out_path}")


def export_stations(conn, latest_date: str, out_path: str):
    rows = conn.execute("""
        SELECT
            p.numero,
            p.nombre,
            g.latitude,
            g.longitude,
            p.sub_producto,
            p.precio,
            p.entidad_id,
            p.direccion
        FROM precios p
        LEFT JOIN georef g ON g.cre_id = p.numero
        WHERE p.fecha = ?
          AND p.precio IS NOT NULL
          AND p.precio > 0
          AND g.latitude IS NOT NULL
          AND g.longitude IS NOT NULL
    """, (latest_date,)).fetchall()

    stations: dict[str, dict] = {}
    for numero, nombre, lat, lon, sub_producto, precio, entidad_id, direccion in rows:
        fuel = classify_fuel(sub_producto)
        if fuel is None:
            continue
        if numero not in stations:
            eid = str(entidad_id).zfill(2)
            stations[numero] = {
                "lat": round(lat, 5),
                "lon": round(lon, 5),
                "name": nombre,
                "code": numero,
                "eid": eid,
                "addr": direccion or "",
                "state": INEGI_TO_ISO.get(eid, {}).get("name", ""),
            }
        entry = stations[numero]
        if fuel not in entry or precio < entry[fuel]:
            entry[fuel] = round(precio, 2)

    output = list(stations.values())

    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False)

    print(f"Stations: {len(output)} stations with coordinates for {latest_date}")
    print(f"  -> {out_path}")


def export(db_path: str, out_dir: str):
    conn = sqlite3.connect(db_path)
    latest_date = get_latest_date(conn)

    if not latest_date:
        print("No data in database.")
        conn.close()
        return

    export_states(conn, latest_date, os.path.join(out_dir, "prices.json"))
    export_stations(conn, latest_date, os.path.join(out_dir, "stations.json"))
    conn.close()


if __name__ == "__main__":
    script_dir = os.path.dirname(os.path.abspath(__file__))
    default_db = os.path.join(script_dir, "cne_precios.db")
    default_out_dir = os.path.join(script_dir, "..", "site", "data")

    parser = argparse.ArgumentParser(description="Export price data to JSON for the map")
    parser.add_argument("--db", default=default_db, help="Path to SQLite database")
    parser.add_argument("--out-dir", default=default_out_dir, help="Output directory for JSON files")
    args = parser.parse_args()

    export(args.db, args.out_dir)
