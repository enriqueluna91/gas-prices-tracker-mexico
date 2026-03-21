# CNE Gas Price API — Reverse Engineering Context

## What this is
We reverse-engineered the Mexican government's fuel price portal (cne.gob.mx) and confirmed it runs on a clean, public, no-auth REST API. No scraping needed.

---

## API Base URLs
Found in `ConfigUrl.js` on the site:

| Name | URL | Purpose |
|------|-----|---------|
| Reporte | `https://api-reportediario.cne.gob.mx` | Daily price reports |
| Catalogo | `https://api-catalogo.cne.gob.mx` | States & municipalities |
| Público | `https://api-publico.cne.gob.mx` | Public API (TBD) |

---

## Confirmed Working Endpoint

```
GET https://api-reportediario.cne.gob.mx/api/EstacionServicio/Petroliferos
    ?entidadId=03
    &municipioId=009
```

### Response shape
```json
{
  "Success": true,
  "Errors": null,
  "Value": [
    {
      "Numero": "PL/5662/EXP/ES/2015",
      "Nombre": "LA DANZANTE S.A. DE C.V.",
      "Direccion": "Calle Benito Juárez No. 98 Esquina Lucas Ventura",
      "Producto": "Gasolinas",
      "SubProducto": "Regular (con contenido menor a 92 octanos)",
      "PrecioVigente": 24.79,
      "EntidadFederativaId": 3,
      "MunicipioId": 9
    }
  ]
}
```

### Field reference
| Field | Values |
|-------|--------|
| `Producto` | `Gasolinas`, `Diésel` |
| `SubProducto` | `Regular (con contenido menor a 92 octanos)`, `Premium (con contenido mínimo de 92 octanos)`, `Diésel` |
| `PrecioVigente` | Float — MXN per liter |
| `EntidadFederativaId` | Integer — zero-padded to 2 digits in request |
| `MunicipioId` | Integer — zero-padded to 3 digits in request |

---

## What's Been Built

**File:** `cne_precios.py`  
**Stack:** Python, `requests`, `sqlite3` — no external dependencies beyond `requests`

### What it does
1. Hits catalog API to get all estados
2. For each estado, fetches all municipios
3. For each estado+municipio combo, calls Petroliferos endpoint
4. Stores results to `cne_precios.db` (SQLite) with date timestamp
5. Idempotent — skips if already ran today
6. 0.3s throttle between calls

### SQLite schema
```sql
CREATE TABLE precios (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha         TEXT,        -- YYYY-MM-DD
    numero        TEXT,        -- Station permit number
    nombre        TEXT,        -- Company name
    direccion     TEXT,        -- Address
    producto      TEXT,        -- Gasolinas / Diésel
    sub_producto  TEXT,        -- Regular / Premium / Diésel
    precio        REAL,        -- MXN per liter
    entidad_id    TEXT,
    municipio_id  TEXT,
    created_at    TEXT
);
```

### Cron schedule (daily 7am)
```bash
0 7 * * * /usr/bin/python3 /path/to/cne_precios.py >> /var/log/cne_precios.log 2>&1
```

---

## Open Item — Needs Validation

The catalog endpoint paths for estados and municipios were **guessed** based on common REST patterns:

```python
# In get_estados() — trying these in order:
/api/Catalogo/EntidadesFederativas
/api/EntidadesFederativas
/api/Catalogo/Entidades

# In get_municipios(entidad_id) — trying these in order:
/api/Catalogo/Municipios?entidadId={id}
/api/Municipios?entidadId={id}
```

**To fix:** In the browser Network tab, grab the actual request URLs for `entidadesfederativas` and `municipios` and patch `get_estados()` and `get_municipios()` in the script.
