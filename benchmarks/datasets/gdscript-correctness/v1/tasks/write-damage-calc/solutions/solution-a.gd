func calculate_damage(base_damage: float, crit_chance: float, crit_multiplier: float) -> float:
	if randf() < crit_chance:
		return base_damage * crit_multiplier
	return base_damage
