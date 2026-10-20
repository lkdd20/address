"""Population-weighted locality quotas for address exports."""
import math
import unicodedata


def fold_name(value):
    # Same folding as foldName in src/domain/region-names.mjs.
    lowered = unicodedata.normalize("NFKC", str(value or "")).lower().replace("đ", "d").replace("ı", "i")
    if any("LATIN" in unicodedata.name(character, "") for character in lowered):
        lowered = "".join(character for character in unicodedata.normalize("NFKD", lowered)
                          if not unicodedata.category(character).startswith("M"))
    return "".join(character for character in lowered if unicodedata.category(character)[0] in "LNM")


def distance_km(longitude, latitude, other_longitude, other_latitude):
    scale = math.cos(math.radians((latitude + other_latitude) / 2))
    return math.hypot((longitude - other_longitude) * scale, latitude - other_latitude) * 111.32


class LocalityWeights:
    """Catalog population and popularity of localities, matched by region and name, and popular cities' metro areas."""

    def __init__(self, document):
        self.baseline = int(document.get("baseline", 10))
        self.city_limit = int(document.get("cityLimit", 30000))
        self.baseline_share = float(document.get("baselineShare", 0.4))
        self.by_locality = {}
        self.popular = []
        for index, place in enumerate(document.get("places", [])):
            entry = {"index": index, "admin1": set(place.get("admin1", [])), "population": int(place.get("population") or 0),
                     "popular": bool(place.get("popular")), "dominant": bool(place.get("dominant")),
                     "longitude": place.get("longitude"), "latitude": place.get("latitude"),
                     "radius": float(place.get("radiusKm") or 0)}
            for key in place.get("locality", []):
                self.by_locality.setdefault(key, []).append(entry)
            if entry["popular"]:
                self.popular.append(entry)

    def match(self, admin1, locality):
        """The catalog place a locality names, or None."""
        places = self.by_locality.get(fold_name(locality), [])
        if not places:
            return None
        region = fold_name(admin1)
        exact = [place for place in places if region and region in place["admin1"]]
        if exact:
            return max(exact, key=lambda place: place["population"])
        best = max(places, key=lambda place: place["population"])
        # Without a region match a shared name only counts as the well-known place when that place dominates it.
        return best if best["dominant"] else min(places, key=lambda place: place["population"])

    def lookup(self, admin1, locality):
        place = self.match(admin1, locality)
        return (place["population"], place["popular"]) if place else (0, False)

    def metro(self, admin1, locality, longitude, latitude):
        """The popular city a locality belongs to: by name, else the nearest popular city whose radius covers it."""
        place = self.match(admin1, locality)
        if place and place["popular"]:
            return place
        if longitude is None or latitude is None:
            return None
        nearby = [(distance_km(longitude, latitude, candidate["longitude"], candidate["latitude"]), candidate)
                  for candidate in self.popular
                  if candidate["longitude"] is not None and candidate["latitude"] is not None and candidate["radius"] > 0]
        nearby = [(distance, candidate) for distance, candidate in nearby if distance <= candidate["radius"]]
        return min(nearby, key=lambda item: item[0])[1] if nearby else None


def locality_weight(population):
    return max(1.0, math.sqrt(max(population, 0) / 10000))


def water_fill(entries, budget):
    active = [entry for entry in entries if entry["quota"] < entry["capacity"]]
    while budget > 1e-9 and active:
        total_weight = sum(entry["weight"] for entry in active)
        saturated = [entry for entry in active
                     if entry["quota"] + budget * entry["weight"] / total_weight >= entry["capacity"]]
        if not saturated:
            for entry in active:
                entry["quota"] += budget * entry["weight"] / total_weight
            return 0
        for entry in saturated:
            budget -= entry["capacity"] - entry["quota"]
            entry["quota"] = entry["capacity"]
        active = [entry for entry in active if entry["quota"] < entry["capacity"]]
    return max(0, budget)


def allocate_quotas(groups, budget, weights):
    """Candidate quota per (admin1, locality): a baseline everywhere (at most `baseline_share` of the budget, so countries
    of many suburbs still fill their cities), then every popular city's metro area up to the city limit as a whole,
    then the rest shared by sqrt(population). A larger budget never lowers a quota, so growing
    shards keep earlier picks. `popular_limit` is the part of a quota that belongs to the popular tier."""
    entries = []
    for group in groups:
        admin1, locality, count = group[:3]
        longitude, latitude = (group[3], group[4]) if len(group) >= 5 else (None, None)
        if locality.strip():
            population, _ = weights.lookup(admin1, locality)
            capacity = min(count, weights.city_limit)
        else:
            # Sources without a city name (NL BAG) get cities from boundaries at import: no city cap applies, and the
            # weight assumes about two residents per address, so these rows keep a density-proportional share.
            population, capacity = 2 * count, count
        metro = weights.metro(admin1, locality, longitude, latitude)
        entries.append({"admin1": admin1, "locality": locality, "count": count, "capacity": capacity,
                        "weight": locality_weight(population), "metro": metro["index"] if metro else None,
                        "quota": 0, "popular_limit": 0})
    baseline_total = sum(min(entry["capacity"], weights.baseline) for entry in entries)
    scale = min(1.0, budget * weights.baseline_share / baseline_total) if baseline_total else 1.0
    for entry in entries:
        entry["quota"] = min(entry["capacity"], weights.baseline) * scale
    remaining = budget - baseline_total * scale
    metros = {}
    for entry in entries:
        if entry["metro"] is not None:
            metros.setdefault(entry["metro"], []).append(entry)
    places = {place["index"]: place for place in weights.popular}
    clusters = [{"members": members, "weight": locality_weight(places[index]["population"]) if index in places else 1.0,
                 "capacity": min(weights.city_limit, sum(member["capacity"] for member in members)),
                 "quota": sum(member["quota"] for member in members)}
                for index, members in metros.items()]
    remaining = water_fill(clusters, remaining)
    for cluster in clusters:
        # A metro area's share goes to its localities in proportion to the addresses they still hold.
        extra = cluster["quota"] - sum(member["quota"] for member in cluster["members"])
        for member in cluster["members"]:
            member["fill"] = {"quota": member["quota"], "capacity": member["capacity"],
                              "weight": max(member["capacity"] - member["quota"], 1e-9)}
        water_fill([member["fill"] for member in cluster["members"]], extra)
        for member in cluster["members"]:
            member["quota"] = member.pop("fill")["quota"]
            member["popular_limit"] = member["quota"]
    water_fill(entries, remaining)
    return entries
