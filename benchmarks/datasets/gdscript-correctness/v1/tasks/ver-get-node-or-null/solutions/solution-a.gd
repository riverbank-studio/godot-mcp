extends Node

func find_optional_hud() -> Control:
	return get_node_or_null("HUD") as Control
