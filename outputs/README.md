# CNE Precios — Gas Price Tracker (Mexico)

Pulls daily fuel prices from the CNE public API and stores them locally in SQLite.

## Requirements

```bash
pip install requests
```
No other dependencies — uses Python standard library (sqlite3, logging, time).

## Run

```bash
python cne_precios.py
```

## Schedule (daily at 7am)

```cron
0 7 * * * /usr/bin/python3 /path/to/cne_precios.py >> /var/log/cne_precios.log 2>&1
```

## Database

Creates `cne_precios.db` in the same directory. Schema:

| Column       | Description                        |
|--------------|------------------------------------|
| fecha        | Date of the record (YYYY-MM-DD)    |
| numero       | Station permit number              |
| nombre       | Station company name               |
| direccion    | Address                            |
| producto     | Gasolinas / Diésel                 |
| sub_producto | Regular / Premium / Diésel         |
| precio       | Current price (MXN/liter)          |
| entidad_id   | Estado ID                          |
| municipio_id | Municipio ID                       |

## Useful queries

```sql
-- Cheapest Magna today
SELECT nombre, direccion, precio
FROM precios
WHERE fecha = date('now') AND sub_producto LIKE '%Regular%'
ORDER BY precio ASC LIMIT 20;

-- Price trend for a specific station
SELECT fecha, sub_producto, precio
FROM precios
WHERE numero = 'PL/5662/EXP/ES/2015'
ORDER BY fecha DESC;

-- Average price by estado today
SELECT entidad_id, sub_producto, ROUND(AVG(precio),2) as avg_precio
FROM precios
WHERE fecha = date('now')
GROUP BY entidad_id, sub_producto
ORDER BY entidad_id;
```

## Notes

- API source: `api-reportediario.cne.gob.mx` (CNE public API)
- No auth required — public government data
- Sleep of 0.3s between requests to avoid hammering the API
- Idempotent — won't double-insert if run twice on same day
