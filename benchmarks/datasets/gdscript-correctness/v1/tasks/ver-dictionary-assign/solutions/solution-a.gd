func merge_stats(base: Dictionary, overrides: Dictionary) -> Dictionary:
	var result := base.duplicate()
	result.merge(overrides, true)
	return result

func shallow_copy(d: Dictionary) -> Dictionary:
	return d.duplicate()
