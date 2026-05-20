## This file is registered as an autoload named 'GameManager' in project settings.
extends Node

var score: int = 0

func add_score(points: int) -> void:
	score += points
