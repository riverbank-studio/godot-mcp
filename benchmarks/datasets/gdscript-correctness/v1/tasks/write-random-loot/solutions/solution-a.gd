func roll_loot(loot_table: Array[Dictionary]) -> Dictionary:
	if loot_table.is_empty():
		return {}

	var total_weight := 0.0
	for entry in loot_table:
		total_weight += entry["weight"]

	var roll := randf() * total_weight
	var accumulated := 0.0
	for entry in loot_table:
		accumulated += entry["weight"]
		if roll <= accumulated:
			return entry

	return loot_table[-1]
