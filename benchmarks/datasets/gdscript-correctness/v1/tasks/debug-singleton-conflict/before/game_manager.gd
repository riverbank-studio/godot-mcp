## This file is registered as an autoload named 'GameManager' in project settings.
## Having both class_name and autoload with the same name causes a parser error.
class_name GameManager  # bug: conflicts with autoload registration
extends Node

var score: int = 0

func add_score(points: int) -> void:
	score += points
